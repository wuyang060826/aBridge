import Foundation

actor AdmissionDriver: DesktopNativeDriver {
    private var gates: [String] = []
    private var failure: String?
    func fail(_ mode: String) { failure = mode }
    private var waiting = Set<String>()
    private var released = Set<String>()
    func arm(_ id: String) { gates.append(id) }
    func releaseGate(_ id: String) { released.insert(id) }
    func releaseAll() { released.formUnion(gates); released.formUnion(waiting); gates.removeAll() }
    func diagnostics(initialize: Bool) async -> JSONObject {
        if initialize, !gates.isEmpty {
            let id = gates.removeFirst(); waiting.insert(id)
            emitJSON(["event": .string("entered"), "id": .string(id)])
            while !released.contains(id) && !Task.isCancelled { try? await sleepMilliseconds(5) }
            waiting.remove(id)
        }
        return ["driver": .object(["ready": .bool(true)]), "permissions": .object(["screen": .bool(true), "input": .bool(true)])]
    }
    func apps() async throws -> [JSONObject] {
        if let failure {
            emitJSON(["event": .string("effect"), "id": .string(failure)])
            if failure == "generic" { throw NSError(domain: "fixture", code: 1, userInfo: [NSLocalizedDescriptionKey: "private fixture command"]) }
            throw DesktopError(code: failure, message: "private fixture driver detail", outcome: "unknown")
        }
        return []
    }
    func windows(pid: Double?) async throws -> [JSONObject] { [] }
    func open(bundleID: String) async throws { throw DesktopError(code: "fixture_forbidden", message: "No real applications in fixture") }
    func observe(session: String, target: JSONObject, screenshot: Bool) async throws -> JSONObject { throw DesktopError(code: "fixture_forbidden", message: "No real desktop in fixture") }
    func act(session: String, action: JSONObject) async throws -> JSONObject { throw DesktopError(code: "fixture_forbidden", message: "No real input in fixture") }
    func release(session: String) async {}
    func shutdown() async { releaseAll() }
}

@main struct AdmissionFixture {
    static func main() async throws {
        let storage = NativeStorage(stateDir: CommandLine.arguments[1])
        let config = try storage.configure(url: CommandLine.arguments[2], key: "abr_device_fixture", capabilities: ["files": true, "screen": true])
        let driver = AdmissionDriver()
        // Use a dedicated injected driver so no real desktop SDK is initialized.
        let client = DeviceClient(storage: storage, config: config, key: "abr_device_fixture", contract: try NativeContract.load(), executor: NativeExecutor(native: driver))
        let running = Task.detached { try await client.run() }
        while let line = readLine() {
            guard let command = try JSONValue.decode(Data(line.utf8)).object else { continue }
            let id = command.string("id") ?? ""
            switch command.string("command") {
            case "fail": await driver.fail(id); emitJSON(["event": .string("failed"), "id": .string(id)])
            case "arm": await driver.arm(id); emitJSON(["event": .string("armed"), "id": .string(id)])
            case "release": await driver.releaseGate(id); emitJSON(["event": .string("released"), "id": .string(id)])
            case "control":
                do { emitJSON(["event": .string("control"), "id": .string(id), "result": .object(try await client.control(command.object("request") ?? [:]))]) }
                catch { emitJSON(["event": .string("control"), "id": .string(id), "error": .object(jsonError(error))]) }
            case "snapshot": emitJSON(["event": .string("snapshot"), "id": .string(id), "result": .object(await client.snapshot())])
            case "stop": await driver.releaseAll(); await client.stop(); try await running.value; return
            default: break
            }
        }
        await driver.releaseAll(); await client.stop(); try await running.value
    }
}
