import Foundation
import Darwin

@main struct UpdaterMain {
    static func main() async {
        let arguments = Array(CommandLine.arguments.dropFirst())
        do {
            var result: [String: Any] = [:]
            switch arguments.first {
            case "check" where arguments.count == 2:
                if let update = try await checkNativeUpdate(arguments[1]) { result["update"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(update)) }
                else { result["update"] = NSNull() }
            case "download" where arguments.count == 5:
                result["plan"] = try await prepareNativeUpdate(app: arguments[1], current: arguments[2], version: arguments[3], stateDir: arguments[4])
            case "install" where arguments.count == 3:
                guard let parent = Int32(arguments[2]) else { throw UpdateFailure("更新计划无效") }
                try installNativeUpdate(arguments[1], parent: parent)
                result["ready"] = true
            case "apply" where arguments.count == 2:
                _ = setsid()
                try await applyNativeUpdate(arguments[1])
                return
            default: throw UpdateFailure("Unknown updater command")
            }
            emit(result)
        } catch {
            emit(["error": error.localizedDescription])
            exit(1)
        }
    }
    private static func emit(_ object: [String: Any]) {
        if let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) { print(text) }
    }
}
