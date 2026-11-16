import AppKit

// Owned update target: no device binding, permissions or network access.
let arguments = CommandLine.arguments
func value(_ flag: String) -> String? {
    guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}
let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
if version == "0.4.9" { exit(1) } // Exercise a launch accepted by open but failing before readiness.
let receipt: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier, "version": version, "ready": true]
let data = try JSONSerialization.data(withJSONObject: receipt)
if let state = value("--state-dir") {
    try data.write(to: URL(fileURLWithPath: state).appendingPathComponent("fixture-pid.json"), options: .atomic)
}
if version == "0.4.10" { signal(SIGTERM, SIG_IGN) }
if version != "0.4.10", let path = value("--update-receipt") { try data.write(to: URL(fileURLWithPath: path), options: .atomic) }
NSApplication.shared.setActivationPolicy(.accessory)
NSApplication.shared.run()
