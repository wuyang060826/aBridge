import Foundation
import AppKit
import ApplicationServices
import Darwin

protocol DesktopNativeDriver: Sendable {
    func diagnostics(initialize: Bool) async -> JSONObject
    func apps() async throws -> [JSONObject]
    func windows(pid: Double?) async throws -> [JSONObject]
    func focusedWindow(pid: Double, candidates: [JSONObject]) async throws -> Double?
    func open(bundleID: String) async throws
    func observe(session: String, target: JSONObject, screenshot: Bool) async throws -> JSONObject
    func act(session: String, action: JSONObject) async throws -> JSONObject
    func release(session: String) async
    func shutdown() async
}

private func consumeDriverBuffer(_ buffer: inout CuaDriverBuffer) -> Data {
    defer { cua_driver_buffer_free_v1(&buffer) }
    guard let p = buffer.data else { return Data() }
    return Data(bytes: p, count: buffer.len)
}

/// Owns the callback and operation token across cancellation and a synchronous callback race.
private final class DriverOperation: @unchecked Sendable {
    private let lock = NSLock()
    private var operation: OpaquePointer?
    private var installed = false
    private var completed = false
    private var cancelled = false
    private var timedOut = false
    private var continuation: CheckedContinuation<Data, Error>?
    func begin(_ continuation: CheckedContinuation<Data, Error>) -> Bool {
        lock.lock()
        if cancelled {
            completed = true; let timeout = timedOut; lock.unlock()
            continuation.resume(throwing: timeout ? DesktopError(code: "driver_timeout", message: "Desktop driver operation timed out", outcome: "outcome_unknown") : CancellationError())
            return false
        }
        self.continuation = continuation; lock.unlock(); return true
    }
    func install(_ value: OpaquePointer?) {
        lock.lock(); installed = true; operation = value
        if cancelled, let operation { cua_driver_operation_cancel_v1(operation) }
        if completed { cua_driver_operation_release_v1(&operation) }
        lock.unlock()
    }
    func cancel(timeout: Bool = false) {
        lock.lock(); cancelled = true; timedOut = timedOut || timeout
        if let operation { cua_driver_operation_cancel_v1(operation) }; lock.unlock()
    }
    func finish(status: Int32, result: Data, error: Data) {
        lock.lock()
        guard !completed else { lock.unlock(); return }
        completed = true
        let continuation = self.continuation; self.continuation = nil
        let cancelled = cancelled, timedOut = timedOut
        if installed { cua_driver_operation_release_v1(&operation) }
        lock.unlock()
        if timedOut { continuation?.resume(throwing: DesktopError(code: "driver_timeout", message: "Desktop driver operation timed out", outcome: "outcome_unknown")) }
        else if cancelled { continuation?.resume(throwing: CancellationError()) }
        else if status != 0 {
            continuation?.resume(throwing: DesktopError(code: "driver_error", message: "Desktop driver operation failed", outcome: "outcome_unknown"))
        } else { continuation?.resume(returning: result) }
    }
}
private let nativeDriverCompletion: CuaDriverCompletionV1 = { context, status, result, error in
    guard let context else { return }
    let operation = Unmanaged<DriverOperation>.fromOpaque(context).takeRetainedValue()
    var result = result, error = error
    operation.finish(status: status, result: consumeDriverBuffer(&result), error: consumeDriverBuffer(&error))
}

// Keep borrowed C pointers in one synchronous, nonisolated scope. The nested
// buffer closures capture no actor state and keep their bytes alive through entry.
private func startDriverOperation(_ driver: OpaquePointer?, nameBytes: [UInt8], arguments: Data, operation: DriverOperation) {
    let context = Unmanaged.passRetained(operation).toOpaque()
    var token: OpaquePointer?, error = CuaDriverBuffer()
    let status = nameBytes.withUnsafeBufferPointer { nameBuffer in
        arguments.withUnsafeBytes { argBuffer in
            cua_driver_invoke_v1(driver, nameBuffer.baseAddress, nameBuffer.count, argBuffer.bindMemory(to: UInt8.self).baseAddress, argBuffer.count, nativeDriverCompletion, context, &token, &error)
        }
    }
    let errorData = consumeDriverBuffer(&error)
    operation.install(token)
    if status != 0 {
        Unmanaged<DriverOperation>.fromOpaque(context).release()
        operation.finish(status: status, result: Data(), error: errorData)
    }
}

actor NativeDriver: DesktopNativeDriver {
    private var driver: OpaquePointer?
    private var closed = false
    private var sessions = Set<String>()
    private var operations: [UUID: DriverOperation] = [:]
    private var lastDiagnostics: JSONObject = ["driver": .object(["loaded": .bool(false), "ready": .bool(false)]), "permissions": .object(["checked": .bool(false), "screen": .bool(false), "input": .bool(false)])]

    static func smoke() async throws -> JSONObject {
        let driver = NativeDriver()
        do {
            let result = try await driver.smokeCheck()
            await driver.shutdown()
            return result
        } catch { await driver.shutdown(); throw error }
    }
    private func smokeCheck() async throws -> JSONObject {
        try ready()
        var inventory = CuaDriverBuffer(), error = CuaDriverBuffer()
        let status = cua_driver_list_tools_json_v1(driver, &inventory, &error)
        _ = consumeDriverBuffer(&error)
        guard status == 0, let tools = try JSONValue.decode(consumeDriverBuffer(&inventory)).object?.array("tools"), !tools.isEmpty else {
            throw DesktopError(code: "driver_unavailable", message: "Desktop driver tool inventory unavailable")
        }
        _ = try await invoke("list_sessions", [:])
        // This check invokes only inventory and session listing, never input or TCC requests.
        return ["embedded": .bool(true), "desktop_actions": .number(0), "authorizations": .number(0), "sdk_version": .string("0.47.8"), "tools": .number(Double(tools.count))]
    }

    private func ready() throws {
        guard !closed else { throw DesktopError(code: "driver_closed", message: "Desktop driver is closed") }
        if driver != nil { return }
        guard cua_driver_abi_is_compatible_v1(1, 1) else { throw DesktopError(code: "driver_unavailable", message: "Unsupported desktop driver ABI") }
        let options: JSONObject = ["claude_code_compatibility": .bool(false), "authorization": .object(["allowed_modes": .array([.string("standard")]), "compatibility_mode": .string("standard"), "unrestricted_acknowledged": .bool(false), "max_session_ttl_seconds": .number(28800), "max_idle_ttl_seconds": .number(1800)])]
        let data = try options.encoded()
        var error = CuaDriverBuffer(), created: OpaquePointer?
        let status = data.withUnsafeBytes { cua_driver_create_v1($0.bindMemory(to: UInt8.self).baseAddress, $0.count, &created, &error) }
        driver = created
        _ = consumeDriverBuffer(&error)
        guard status == 0, driver != nil else { throw DesktopError(code: "driver_unavailable", message: "Desktop driver unavailable") }
        var metadata = CuaDriverBuffer()
        let metadataStatus = cua_driver_metadata_json_v1(driver, &metadata, &error)
        _ = consumeDriverBuffer(&error)
        let info = try? JSONValue.decode(consumeDriverBuffer(&metadata)).object
        guard metadataStatus == 0, info?.bool("embedded") == true, info?.number("pid") == Double(getpid()), info?.string("driver_version") == "0.47.8" else {
            cua_driver_destroy_v1(&driver)
            throw DesktopError(code: "driver_unavailable", message: "Desktop driver must run embedded in this process")
        }
    }
    private func invoke(_ name: String, _ arguments: JSONObject, timeout: Double = 30000) async throws -> JSONObject {
        try Task.checkCancellation(); try ready()
        let id = UUID(), operation = DriverOperation()
        operations[id] = operation
        defer { operations.removeValue(forKey: id) }
        let args = try arguments.encoded(), nameBytes = Array(name.utf8)
        let timer = Task { try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000)); if !Task.isCancelled { operation.cancel(timeout: true) } }
        defer { timer.cancel() }
        let data = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                guard operation.begin(continuation) else { return }
                startDriverOperation(driver, nameBytes: nameBytes, arguments: args, operation: operation)
            }
        } onCancel: { operation.cancel() }
        try Task.checkCancellation()
        return try Self.decodeReply(data)
    }
    nonisolated static func decodeReply(_ data: Data) throws -> JSONObject {
        guard let result = try JSONValue.decode(data).object else { throw DesktopError(code: "driver_error", message: "Invalid desktop driver response", outcome: "outcome_unknown") }
        if result.bool("isError") == true || result.bool("is_error") == true {
            let structured = result.object("structuredContent") ?? [:]
            let code = structured.string("code") ?? structured.object("refusal")?.string("code") ?? structured.object("error")?.string("code") ?? result.string("errorCode") ?? "outcome_unknown"
            let recovery = actionRecovery(code)
            let known = ["action_refused", "permission_denied", "permission_required", "accessibility_permission_required", "screen_recording_permission_required", "invalid_arguments", "session_not_found", "session_closed", "unsupported"]
            throw DesktopError(code: code, message: recovery ?? "Desktop driver could not complete the requested operation", outcome: recovery != nil || known.contains(code) ? "refused" : "outcome_unknown", hint: recovery)
        }
        return result
    }
    nonisolated static func actionRecovery(_ code: String) -> String? {
        switch code {
        case "stale_capture", "capture_id_invalid", "capture_not_found", "capture_expired", "capture_generation_mismatch", "capture_target_mismatch", "capture_frame_mismatch", "capture_coordinate_invalid", "px_capture_unavailable", "px_frame_mismatch":
            return "Refresh the same window with computer_observe and use coordinates from the new screenshot."
        case "stale_element", "element_outside_target_window":
            return "Refresh the same window with computer_observe and use an element_ref from the new observation."
        case "target_not_found", "window_not_found", "window_id_not_found", "window_owner_pid_mismatch", "owner_pid_mismatch", "px_window_not_found":
            return "Use computer_windows to find the intended window, then observe it again."
        case "off_space_or_ax_unresolved", "minimized_or_hidden_window":
            return "Make the intended window available on the current space, then observe it again."
        case "screen_locked":
            return "Unlock the Mac and refresh the same target."
        case "same_pid_keyboard_ambiguity":
            return "Use a supported element action in the intended window."
        case "background_unavailable":
            return "Observe the same window and try a supported element action. A foreground click requires an explicit request and verified focus."
        default:
            return nil
        }
    }
    private func session(_ id: String) async throws {
        if sessions.contains(id) { return }
        _ = try await invoke("start_session", ["session": .string(id)])
        sessions.insert(id)
    }
    func diagnostics(initialize: Bool = true) async -> JSONObject {
        if !initialize { return lastDiagnostics }
        do {
            try ready()
            lastDiagnostics = ["driver": .object(["installed": .bool(true), "loaded": .bool(true), "ready": .bool(true), "version": .string("0.47.8")]), "permissions": .object(["checked": .bool(true), "screen": .bool(CGPreflightScreenCaptureAccess()), "input": .bool(AXIsProcessTrusted())])]
        } catch { lastDiagnostics = ["driver": .object(["installed": .bool(false), "ready": .bool(false), "error": .string("Desktop driver unavailable")]), "permissions": .object(["checked": .bool(false), "screen": .bool(false), "input": .bool(false)])] }
        return lastDiagnostics
    }
    func apps() async throws -> [JSONObject] {
        let result = try await invoke("list_apps", [:])
        return (result.object("structuredContent")?.array("apps") ?? []).compactMap { value in
            guard let app = value.object else { return nil }
            return app.filter { ["pid", "name", "bundle_id", "running", "active"].contains($0.key) }
        }
    }
    func windows(pid: Double? = nil) async throws -> [JSONObject] {
        var args: JSONObject = ["on_screen_only": .bool(false)]; if let pid { args["pid"] = .number(pid) }
        let result = try await invoke("list_windows", args)
        return (result.object("structuredContent")?.array("windows") ?? []).compactMap { value in
            guard let window = value.object, let id = window.number("window_id"), id > 0, id <= 9_007_199_254_740_991, id.rounded() == id else { return nil }
            return window.filter { ["pid", "window_id", "app_name", "title", "bounds", "is_on_screen", "layer", "z_index"].contains($0.key) }
        }
    }
    private func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }
    private func focusedElement(pid: Double, system: AXUIElement) -> AXUIElement? {
        guard let application = attribute(system, kAXFocusedApplicationAttribute),
              CFGetTypeID(application) == AXUIElementGetTypeID() else { return nil }
        var activePid: pid_t = 0
        let app = application as! AXUIElement
        guard AXUIElementGetPid(app, &activePid) == .success, Double(activePid) == pid,
              let window = attribute(app, kAXFocusedWindowAttribute), CFGetTypeID(window) == AXUIElementGetTypeID() else { return nil }
        return (window as! AXUIElement)
    }
    func focusedWindow(pid: Double, candidates: [JSONObject]) async throws -> Double? {
        guard let focused = focusedElement(pid: pid, system: AXUIElementCreateSystemWide()) else { return nil }
        guard let position = attribute(focused, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
              let size = attribute(focused, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
        var origin = CGPoint.zero, dimensions = CGSize.zero
        guard AXValueGetValue(position as! AXValue, .cgPoint, &origin),
              AXValueGetValue(size as! AXValue, .cgSize, &dimensions),
              dimensions.width > 0, dimensions.height > 0 else { return nil }
        let frame = CGRect(origin: origin, size: dimensions)
        let matching = candidates.filter { Self.windowFrame($0.object("bounds")) == frame }
        if matching.count == 1 { return matching[0].number("window_id") }
        guard let title = attribute(focused, kAXTitleAttribute) as? String, !title.isEmpty else { return nil }
        let titled = matching.filter { $0.string("title") == title }
        return titled.count == 1 ? titled[0].number("window_id") : nil
    }
    func open(bundleID: String) async throws {
        let result = try await NativeShell.run(executable: "/usr/bin/open", arguments: ["-b", bundleID], cwd: NSHomeDirectory(), environment: ProcessInfo.processInfo.environment, timeout: 5000, output: nil)
        guard result.number("exit_code") == 0, result.bool("timed_out") != true else { throw DesktopError(code: "app_launch_failed", message: "Application launch failed") }
    }
    func observe(session id: String, target: JSONObject, screenshot: Bool) async throws -> JSONObject {
        try await session(id)
        let desktop = target.bool("desktop") == true
        if desktop && !screenshot { return ["elements": .array([])] }
        var args = target
        args.removeValue(forKey: "desktop")
        args["session"] = .string(id); args["max_image_dimension"] = .number(1920)
        if !desktop {
            args["include_screenshot"] = .bool(screenshot); args["include_accessibility_tree"] = .bool(true)
            args["tree_format"] = .string("elements"); args["max_elements"] = .number(500); args["max_depth"] = .number(12)
            args["verbose"] = .bool(true)
        }
        let result = try await invoke(desktop ? "get_desktop_state" : "get_window_state", args)
        let data = result.object("structuredContent") ?? [:]
        var observation: JSONObject = [:]
        for key in ["app_name", "window_title", "truncated", "capture_id", "window_bounds", "background_input"] { observation[key] = data[key] }
        observation["frame_valid"] = data["screenshot_frame_valid"]
        observation["elements"] = .array(desktop ? [] : (data.array("elements") ?? []).compactMap { value in
            guard let element = value.object else { return nil }
            var mapped = element.filter { ["role", "label", "enabled", "selected", "depth", "actions"].contains($0.key) }
            mapped["token"] = element["element_token"]; mapped["value"] = element["value"] ?? element["value_description"]
            return .object(mapped)
        })
        if let image = result.array("content")?.compactMap(\.object).first(where: { $0.string("type") == "image" }), let base64 = image.string("data") {
            observation["image_base64"] = .string(base64); observation["mime_type"] = image["mimeType"]
            observation["width"] = data["screenshot_width"] ?? data["width"]
            observation["height"] = data["screenshot_height"] ?? data["height"]
            if let png = Data(base64Encoded: base64), png.count >= 24, Array(png.prefix(8)) == [137,80,78,71,13,10,26,10] {
                func uint32(_ offset: Int) -> Double { Double(png[offset..<offset+4].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }) }
                if observation.number("width") == nil { observation["width"] = .number(uint32(16)) }
                if observation.number("height") == nil { observation["height"] = .number(uint32(20)) }
            }
        }
        return observation
    }
    nonisolated static func actionRequest(session id: String, action: JSONObject) throws -> (String, JSONObject) {
        guard let kind = action.string("action"), let target = action.object("target") else { throw DesktopError(code: "invalid_arguments", message: "Missing desktop action target") }
        var wire: JSONObject = [:]
        wire["session"] = .string(id)
        wire["target"] = .object(target.bool("desktop") == true ? ["kind": .string("desktop"), "display_id": .string("primary")] : target.merging(["kind": .string("window")]) { _, new in new })
        var tool: String
        switch kind {
        case "click", "double_click":
            tool = "click"; wire["element_token"] = action["native_ref"]
            if wire["element_token"] == nil {
                for key in ["x", "y", "capture_id"] { wire[key] = action[key] }
            }
            wire["button"] = action["button"]
            wire["modifier"] = action["modifiers"]; wire["count"] = .number(kind == "double_click" ? 2 : 1)
            wire["delivery_mode"] = action["delivery_mode"] ?? .string("background")
        case "type": tool = "type_text"; wire["element_token"] = action["native_ref"]; wire["text"] = action["text"]
        case "key": tool = "press_key"; wire["modifiers"] = action["modifiers"]; wire["key"] = action["key"]
        case "move": tool = "move_cursor"; wire["x"] = action["x"]; wire["y"] = action["y"]
        case "drag":
            tool = "drag"; wire["from_x"] = action["x"]; wire["from_y"] = action["y"]; wire["modifier"] = action["modifiers"]
            wire["to_x"] = action["to_x"]; wire["to_y"] = action["to_y"]
        case "scroll":
            tool = "scroll"; let dy = action.number("delta_y") ?? 0, d = dy != 0 ? dy : action.number("delta_x") ?? 0
            wire.removeValue(forKey: "delta_x"); wire.removeValue(forKey: "delta_y")
            wire["direction"] = .string(dy != 0 ? (d < 0 ? "up" : "down") : (d < 0 ? "left" : "right"))
            wire["amount"] = .number(max(1, min(50, (abs(d)/40).rounded())))
            wire["x"] = action["x"]; wire["y"] = action["y"]
        default: throw DesktopError(code: "invalid_arguments", message: "Unsupported desktop action")
        }
        return (tool, wire)
    }

    nonisolated static func windowFrame(_ bounds: JSONObject?) -> CGRect? {
        guard let bounds, let x = bounds.number("x"), let y = bounds.number("y"),
              let width = bounds.number("width"), let height = bounds.number("height"), width > 0, height > 0 else { return nil }
        return CGRect(x: x, y: y, width: width, height: height)
    }

    private func pointHitsFocusedElement(_ point: CGPoint, pid: Double) -> Bool {
        let system = AXUIElementCreateSystemWide()
        guard let focused = focusedElement(pid: pid, system: system) else { return false }
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &hit) == .success,
              let hit else { return false }
        if CFEqual(focused, hit) { return true }
        guard let hitWindow = attribute(hit, kAXWindowAttribute) else { return false }
        return CFEqual(focused, hitWindow)
    }

    private func checkForegroundPoint(_ action: JSONObject, target: JSONObject) throws {
        let hint = "Bring the intended window to the front and use coordinates from a fresh computer_observe screenshot."
        guard let frame = Self.windowFrame(action.object("window_bounds")),
              let position = action.object("window_position"),
              let x = position.number("x"), let y = position.number("y"),
              let pid = target.number("pid"), let id = target.number("window_id"),
              let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            throw DesktopError(code: "window_frame_unavailable", message: "Cannot verify the screen position of the target", hint: hint)
        }
        func frameOf(_ entry: [String: Any]) -> CGRect? {
            guard let bounds = entry[kCGWindowBounds as String] as? NSDictionary else { return nil }
            return CGRect(dictionaryRepresentation: bounds as CFDictionary)
        }
        guard let window = windows.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.doubleValue == id }),
              (window[kCGWindowOwnerPID as String] as? NSNumber)?.doubleValue == pid else {
            throw DesktopError(code: "window_unavailable", message: "The observed window is no longer on screen", hint: hint)
        }
        guard frameOf(window) == frame else {
            throw DesktopError(code: "window_frame_changed", message: "The target window moved or resized after observation", hint: hint)
        }
        let point = CGPoint(x: frame.minX + x * frame.width, y: frame.minY + y * frame.height)
        // Cua maps capture pixels through the original bitmap and a discrete
        // backing scale, with up to 3% frame tolerance. Check that entire
        // possible destination stays inside the window and clear of blockers.
        let toleranceX = 1 + x * frame.width * 0.03
        let toleranceY = 1 + y * frame.height * 0.03
        let destination = CGRect(x: point.x - toleranceX, y: point.y - toleranceY,
                                 width: 2 * toleranceX, height: 2 * toleranceY)
        guard frame.contains(destination) else {
            throw DesktopError(code: "window_point_near_edge", message: "The screenshot point is too close to the window edge", hint: "Choose a point farther inside the intended control in the current screenshot.")
        }
        var display: CGDirectDisplayID = 0, displays: UInt32 = 0
        guard CGGetDisplaysWithPoint(point, 1, &display, &displays) == .success, displays > 0,
              CGDisplayBounds(display).contains(destination) else {
            throw DesktopError(code: "window_point_offscreen", message: "The screenshot point is outside the visible displays", hint: hint)
        }
        let hits = windows.lazy.filter { entry in
            // The embedded driver draws its own click-through cursor overlay in this process.
            (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value != getpid()
                && (entry[kCGWindowAlpha as String] as? NSNumber)?.doubleValue != 0
                && frameOf(entry)?.intersects(destination) == true
        }
        let blockers = hits.prefix { ($0[kCGWindowNumber as String] as? NSNumber)?.doubleValue != id }
        // Dock can publish a full-screen WindowServer frame for an overlay. Require
        // a separate AX hit on the focused window before disregarding that frame.
        let onlyDockOverlay = !blockers.isEmpty && blockers.allSatisfy { entry in
            guard let owner = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value else { return false }
            return (entry[kCGWindowLayer as String] as? NSNumber)?.int32Value == CGWindowLevelForKey(.dockWindow)
                && frameOf(entry) == CGDisplayBounds(display)
                && NSRunningApplication(processIdentifier: owner)?.bundleIdentifier == "com.apple.dock"
        }
        guard hits.contains(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.doubleValue == id }),
              blockers.isEmpty || (onlyDockOverlay && pointHitsFocusedElement(point, pid: pid)) else {
            throw DesktopError(code: "window_point_occluded", message: "The screenshot point is covered by another surface", hint: hint)
        }
    }

    func act(session id: String, action: JSONObject) async throws -> JSONObject {
        try await session(id)
        let (tool, wire) = try Self.actionRequest(session: id, action: action)
        if tool == "click", wire.string("delivery_mode") == "foreground",
           let target = action.object("target"), target.number("pid") != nil {
            try checkForegroundPoint(action, target: target)
        }
        let reply = try await invoke(tool, wire)
        let result = reply.object("structuredContent") ?? [:]
        if result.object("error") != nil || result.string("effect") == "refused" {
            let code = result.object("error")?.string("code") ?? result.string("code") ?? "action_refused"
            throw DesktopError(code: code, message: "Desktop action was refused", hint: Self.actionRecovery(code))
        }
        var output: JSONObject = ["action_executed": .bool(true), "business_verified": .bool(false)]
        for key in ["effect", "route", "delivery"] { output[key] = result[key] }
        if ["unverifiable", "partial", "suspected_noop"].contains(result.string("effect") ?? "") {
            output["hint"] = .string("Verify the expected change in the follow-up observation or refresh the same target before continuing.")
        }
        if let summary = result.string("summary") { output["summary"] = .string(String(summary.prefix(500))) }
        return output
    }
    func release(session id: String) async {
        guard sessions.remove(id) != nil, !closed else { return }
        _ = try? await invoke("end_session", ["session": .string(id)], timeout: 5000)
    }
    func shutdown() async {
        guard !closed else { return }; closed = true
        for operation in operations.values { operation.cancel() }
        while !operations.isEmpty { await Task.detached { try? await Task.sleep(nanoseconds: 10_000_000) }.value }
        sessions.removeAll()
        if driver != nil {
            let operation = DriverOperation()
            let timer = Task { try? await Task.sleep(nanoseconds: 10_000_000_000); if !Task.isCancelled { operation.cancel(timeout: true) } }
            _ = try? await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
                guard operation.begin(continuation) else { return }
                let context = Unmanaged.passRetained(operation).toOpaque()
                var token: OpaquePointer?, error = CuaDriverBuffer()
                let status = cua_driver_shutdown_v1(driver, nativeDriverCompletion, context, &token, &error)
                let errorData = consumeDriverBuffer(&error); operation.install(token)
                if status != 0 { Unmanaged<DriverOperation>.fromOpaque(context).release(); operation.finish(status: status, result: Data(), error: errorData) }
            }
            timer.cancel(); cua_driver_destroy_v1(&driver)
        }
        lastDiagnostics["driver"] = .object(["loaded": .bool(false), "ready": .bool(false)])
    }
}
