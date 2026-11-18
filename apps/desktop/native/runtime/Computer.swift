import Foundation
import Darwin

actor NativeComputer {
    private struct Observation {
        let id: String
        let created: Double
        let target: JSONObject
        var refs: [String: String] = [:]
        var width: Double?
        var height: Double?
        let captureID: String?
        let focus: String?
    }
    private let native: any DesktopNativeDriver
    private let now: @Sendable () -> Double
    private var observations: [String: Observation] = [:]
    private var targets: [String: JSONObject] = [:]
    private var closed = Set<String>()
    private var queues: [String: (UUID, Task<JSONObject, Error>)] = [:]
    private var sessions = Set<String>()
    private var referenceSequence = UInt64.random(in: 0..<(1 << 48))
    init(native: any DesktopNativeDriver, now: @escaping @Sendable () -> Double = { ProcessInfo.processInfo.systemUptime }) { self.native = native; self.now = now }
    func execute(session: String, tool: String, arguments: JSONObject) async throws -> JSONObject {
        if tool == "computer_apps" { return try await apps(arguments) }
        if tool == "computer_windows" { return try await windows(arguments) }
        guard !session.isEmpty else { throw DesktopError(code: "session_required", message: "Desktop operation requires a session") }
        sessions.insert(session)
        let previous = queues[session]?.1, key = UUID()
        let task = Task {
            _ = try? await previous?.value
            try Task.checkCancellation()
            switch tool {
            case "computer_open": return try await self.open(session, arguments)
            case "computer_observe": return try await self.observe(session, arguments)
            case "computer_act": return try await self.act(session, arguments)
            default: throw DesktopError(code: "unsupported_tool", message: "Unsupported desktop tool")
            }
        }
        queues[session] = (key, task)
        defer { if queues[session]?.0 == key { queues.removeValue(forKey: session) } }
        return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    }
    private func assertOpen(_ session: String) throws {
        try Task.checkCancellation()
        if closed.contains(session) { throw DesktopError(code: "session_closed", message: "Desktop session has closed") }
    }
    private func referenceID() throws -> String {
        guard referenceSequence < (1 << 48) else { throw DesktopError(code: "reference_exhausted", message: "Reference IDs exhausted; restart the client") }
        var value = referenceSequence; referenceSequence += 1
        let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        var suffix = ""
        for _ in 0..<8 { suffix.insert(alphabet[Int(value % 64)], at: suffix.startIndex); value /= 64 }
        return "obs_" + suffix
    }
    private func apps(_ args: JSONObject) async throws -> JSONObject {
        let query = args.string("query")?.lowercased()
        let apps = try await native.apps().filter { app in
            if let query { return "\(app.string("name") ?? "")\n\(app.string("bundle_id") ?? "")".lowercased().contains(query) }
            return app.bool("running") == true && (app.number("pid") ?? 0) > 0
        }
        var rows: [JSONValue] = []
        for app in apps.prefix(200) {
            rows.append(.object(app))
            if try JSONValue.array(rows).encoded().count > 6000 { rows.removeLast(); break }
        }
        return ["apps": .array(rows), "matches_total": .number(Double(apps.count)), "truncated": .bool(rows.count < apps.count)]
    }
    private func windows(_ args: JSONObject) async throws -> JSONObject {
        let pid = args.number("pid"), windows = try await native.windows(pid: args.number("pid"))
        var running: Bool?
        if let pid { running = Darwin.kill(pid_t(pid), 0) == 0 || errno == EPERM }
        var result: JSONObject = ["windows": .array(windows.prefix(200).map(JSONValue.object)), "requested_pid": pid.map(JSONValue.number) ?? .null, "process_running": running.map(JSONValue.bool) ?? .null, "on_screen_only": .bool(false), "truncated": .bool(windows.count > 200), "empty_reason": windows.isEmpty ? .string(running == false ? "process_not_running" : "no_windows_reported") : .null]
        if windows.isEmpty { result["guidance"] = .string("Refresh computer_apps/windows and observe a returned pid/window_id; off-screen windows are included") }
        return result
    }
    private func focus() async throws -> String? {
        do {
            let active = try await native.apps().filter { $0.bool("active") == true && $0.bool("running") == true }
            guard active.count == 1, let pid = active[0].number("pid") else { return nil }
            let windows = try await native.windows(pid: pid).filter { $0.bool("is_on_screen") == true && $0.number("layer") == 0 && $0.number("z_index") != nil }.sorted { $0.number("z_index")! > $1.number("z_index")! }
            guard let first = windows.first, let windowID = first.number("window_id"), windows.count == 1 || first.number("z_index") != windows[1].number("z_index") else { return nil }
            return "\(pid):\(windowID)"
        } catch { try Task.checkCancellation(); return nil }
    }
    private func open(_ session: String, _ args: JSONObject) async throws -> JSONObject {
        guard let bundle = args.string("bundle_id"), try await native.apps().contains(where: { $0.string("bundle_id") == bundle }) else { throw DesktopError(code: "app_not_found", message: "Application is not installed") }
        try assertOpen(session); try await native.open(bundleID: bundle)
        var base: JSONObject = ["launch_requested": .bool(true), "bundle_id": .string(bundle)]
        let followUp = Task { try await self.openObservation(session, args, bundle) }
        let timer = Task { try? await Task.sleep(nanoseconds: 8_000_000_000); if !Task.isCancelled { followUp.cancel() } }
        defer { timer.cancel() }
        do {
            let observation = try await withTaskCancellationHandler { try await followUp.value } onCancel: { followUp.cancel() }
            base["observation"] = .object(observation)
        } catch {
            try Task.checkCancellation()
            base["observation_error"] = .object(["code": .string((error as? DesktopError)?.code ?? "window_unavailable"), "message": .string("Application launch requested; follow-up window observation unavailable")])
        }
        return base
    }
    private func openObservation(_ session: String, _ args: JSONObject, _ bundle: String) async throws -> JSONObject {
        for _ in 0..<16 {
            try assertOpen(session)
            if let app = try await native.apps().first(where: { $0.string("bundle_id") == bundle && $0.bool("running") == true && ($0.number("pid") ?? 0) > 0 }), let pid = app.number("pid") {
                let windows = try await native.windows(pid: pid).filter { $0.number("layer") == 0 && ($0.object("bounds")?.number("width") ?? 0) > 0 && ($0.object("bounds")?.number("height") ?? 0) > 0 }.sorted { a, b in
                    if a.bool("is_on_screen") != b.bool("is_on_screen") { return a.bool("is_on_screen") == true }
                    let aa = (a.object("bounds")?.number("width") ?? 0) * (a.object("bounds")?.number("height") ?? 0)
                    let ba = (b.object("bounds")?.number("width") ?? 0) * (b.object("bounds")?.number("height") ?? 0)
                    return aa > ba
                }
                if let window = windows.first, let id = window["window_id"] { return try await observe(session, ["pid": .number(pid), "window_id": id, "screenshot": .bool(args.bool("screenshot") ?? false)]) }
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        throw DesktopError(code: "window_unavailable", message: "Application launched but no ordinary window appeared")
    }
    private func observe(_ session: String, _ args: JSONObject) async throws -> JSONObject {
        try assertOpen(session)
        var target: JSONObject
        if let pid = args.number("pid") {
            if let id = args.number("window_id") { target = ["pid": .number(pid), "window_id": .number(id)] }
            else {
                let windows = try await native.windows(pid: pid).filter { $0.number("pid") == pid && ($0.number("window_id") ?? 0) > 0 }
                try assertOpen(session)
                if windows.isEmpty { throw DesktopError(code: "window_unavailable", message: "No window is available; refresh computer_windows") }
                if windows.count > 1 { throw DesktopError(code: "window_selection_required", message: "Multiple windows are available; provide pid and window_id from computer_windows") }
                target = ["pid": .number(pid), "window_id": windows[0]["window_id"]!]
            }
        } else if args.bool("desktop") == true { target = ["desktop": .bool(true)] }
        else if let previous = targets[session], previous.number("pid") != nil { target = previous }
        else { throw DesktopError(code: "target_required", message: "Provide pid and window_id, or set desktop=true") }
        let before = target.bool("desktop") == true ? try await focus() : nil
        try assertOpen(session)
        let raw = try await native.observe(session: session, target: target, screenshot: args.bool("screenshot") != false)
        try assertOpen(session)
        let after = before != nil ? try await focus() : nil
        try assertOpen(session)
        var observation = Observation(id: try referenceID(), created: now(), target: target, width: raw.number("width"), height: raw.number("height"), captureID: raw.string("capture_id"), focus: before == after ? before : nil)
        let result = try compact(raw, &observation, query: args.string("query"))
        observations[session] = observation; targets[session] = target
        return result
    }
    private func compact(_ raw: JSONObject, _ observation: inout Observation, query: String?) throws -> JSONObject {
        var result: JSONObject = ["observation_id": .string(observation.id), "elements": .array([])]
        for key in ["app_name", "window_title"] { if let value = raw.string(key) { result[key] = .string(String(value.prefix(200))) } }
        if observation.target.number("pid") != nil { result["window"] = .object(observation.target) }
        else { result["desktop"] = .bool(true); result["focus_status"] = .string(observation.focus != nil ? "confirmed" : "unconfirmed") }
        var rows: [JSONValue] = [], matches = 0, truncated = raw.bool("truncated") ?? false
        for element in (raw.array("elements") ?? []).compactMap(\.object) {
            let role = element.string("role") ?? "", lower = role.lowercased(), label = element.string("label") ?? ""
            let value = ["secure", "password", "protected"].contains(where: lower.contains) ? nil : element.string("value")
            if let query, !query.isEmpty, !"\(label)\n\(value ?? "")".lowercased().contains(query.lowercased()) { continue }
            let actionable = element.string("token") != nil && (!(element.array("actions") ?? []).isEmpty || ["button", "check", "text", "menu", "popup", "slider", "link"].contains(where: lower.contains))
            if label.isEmpty && (value ?? "").isEmpty && !actionable { continue }
            matches += 1
            let ref = "e\(rows.count + 1)"
            var row: JSONObject = ["role": .string(role), "label": .string(String(label.prefix(query == nil ? 240 : 2000)))]
            row["depth"] = element["depth"]
            if let value { row["value"] = .string(String(value.prefix(query == nil ? 384 : 4500))) }
            if actionable { row["element_ref"] = .string(ref) }
            if element.bool("enabled") == false { row["enabled"] = .bool(false) }
            if element.bool("selected") == true { row["selected"] = .bool(true) }
            rows.append(.object(row)); result["elements"] = .array(rows)
            if try result.encoded().count > 7000 { rows.removeLast(); truncated = true; continue }
            if actionable { observation.refs[ref] = element.string("token") }
        }
        result["elements"] = .array(rows); result["elements_total"] = .number(Double(matches)); result["truncated"] = .bool(truncated)
        if truncated { result["next_step"] = .string("Use query to narrow the accessibility tree") }
        if let image = raw.string("image_base64"), let mime = raw.string("mime_type"), ["image/png", "image/jpeg", "image/webp"].contains(mime), image.utf8.count <= 5_592_408, let bytes = Data(base64Encoded: image), !bytes.isEmpty, bytes.count <= 4 * 1024 * 1024 {
            result["image_base64"] = .string(image); result["mime_type"] = .string(mime)
        }
        let pixel = result["image_base64"] != nil && (observation.width ?? 0) > 0 && (observation.height ?? 0) > 0 && raw.bool("frame_valid") != false
        result["pixel_actions"] = .bool(pixel && (observation.target.number("pid") != nil || observation.focus != nil))
        if pixel {
            result["coordinate_space"] = .string("screenshot_pixels")
            result["geometry"] = .object(["width": .number(observation.width!), "height": .number(observation.height!)])
        } else { observation.width = nil; observation.height = nil }
        return result
    }
    private func act(_ session: String, _ args: JSONObject) async throws -> JSONObject {
        try assertOpen(session)
        guard let observation = observations[session], args.string("observation_id") == observation.id, now() - observation.created <= 120 else { throw DesktopError(code: "stale_observation", message: "Observe the target again before acting") }
        if observation.target.bool("desktop") == true && observation.focus == nil { throw DesktopError(code: "focus_unavailable", message: "Desktop focus is unconfirmed; observe again or select a window") }
        guard let action = args.object("action"), let kind = action.string("type") else { throw DesktopError(code: "invalid_arguments", message: "Missing desktop action") }
        var request: JSONObject = ["action": .string(kind), "target": .object(observation.target)]
        if let capture = observation.captureID { request["capture_id"] = .string(capture) }
        if let ref = action.string("element_ref") {
            guard let token = observation.refs[ref] else { throw DesktopError(code: "invalid_reference", message: "Element reference is not in this observation") }
            request["native_ref"] = .string(token)
        }
        func point(_ x: Double?, _ y: Double?) throws -> (JSONValue, JSONValue) {
            guard let width = observation.width, let height = observation.height else { throw DesktopError(code: "screenshot_required", message: "Observe with a screenshot before pixel actions") }
            guard let x, let y, x.isFinite, y.isFinite, x >= 0, y >= 0, x < width, y < height else { throw DesktopError(code: "invalid_arguments", message: "Coordinates must be inside the observed screenshot") }
            return (.number(x), .number(y))
        }
        switch kind {
        case "click", "double_click":
            if action.string("element_ref") == nil { (request["x"], request["y"]) = try point(action.number("x"), action.number("y")) }
            request["button"] = action["button"]
        case "type": request["text"] = action["text"]
        case "key": request["key"] = action["key"]
        case "move": (request["x"], request["y"]) = try point(action.number("x"), action.number("y"))
        case "drag":
            (request["x"], request["y"]) = try point(action.number("x"), action.number("y"))
            (request["to_x"], request["to_y"]) = try point(action.number("to_x"), action.number("to_y"))
        case "scroll":
            guard let width = observation.width, let height = observation.height else { throw DesktopError(code: "screenshot_required", message: "Observe with a screenshot before scrolling") }
            request["x"] = .number(floor(width/2)); request["y"] = .number(floor(height/2)); request["delta_x"] = action["delta_x"]; request["delta_y"] = action["delta_y"]
        default: throw DesktopError(code: "invalid_arguments", message: "Unsupported desktop action")
        }
        if let modifiers = action.array("modifiers") {
            let aliases = ["command": "cmd", "control": "ctrl", "alt": "option"]
            request["modifiers"] = .array(modifiers.compactMap(\.string).map { .string(aliases[$0] ?? $0) })
        }
        try assertOpen(session)
        if let expected = observation.focus {
            guard let current = try await focus() else { throw DesktopError(code: "focus_unavailable", message: "Cannot verify the current focus; observe again or select a window") }
            try assertOpen(session)
            if current != expected { throw DesktopError(code: "focus_changed", message: "The front window changed; observe again") }
        }
        try assertOpen(session)
        // Consume before delivery: failed/unknown writes are never replayed with an old reference.
        observations.removeValue(forKey: session)
        var result = try await native.act(session: session, action: request)
        if args.bool("observe_after") == false && args.bool("screenshot") != true { return result }
        do {
            try assertOpen(session)
            try await Task.sleep(nanoseconds: UInt64(max(0, args.number("wait_after_ms") ?? 2000) * 1_000_000))
            var next = observation.target; next["screenshot"] = .bool(args.bool("screenshot") == true)
            result["observation"] = .object(try await observe(session, next))
        } catch {
            result["observation_error"] = .object(["code": .string((error as? DesktopError)?.code ?? "observation_failed"), "message": .string("Action delivered; follow-up observation unavailable")])
        }
        return result
    }
    func closeSession(_ session: String) async {
        closed.insert(session); observations.removeValue(forKey: session); targets.removeValue(forKey: session)
        let pending = queues[session]?.1; pending?.cancel(); _ = try? await pending?.value
        await native.release(session: session); sessions.remove(session)
    }
    func stop() async { for session in Array(sessions) { await closeSession(session) } }
    func shutdown() async { await stop(); await native.shutdown() }
}
