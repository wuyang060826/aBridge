import Foundation

@main struct NativeUpdaterTests {
    static func main() throws {
        func asset(_ suffix: String = "unsigned") -> [String: Any] {
            ["name": "aBridge-0.4.8-macos-arm64-\(suffix).zip", "browser_download_url": "https://github.com/xerrors/aBridge/releases/download/v0.4.8/aBridge-0.4.8-macos-arm64-\(suffix).zip", "digest": "sha256:" + String(repeating: "a", count: 64), "size": 123]
        }
        func release() -> [String: Any] { ["tag_name": "v0.4.8", "draft": false, "prerelease": false, "assets": [asset()]] }
        func expectFailure(_ action: () throws -> Void) {
            do { try action(); fatalError("Expected validation failure") } catch {}
        }
        let comparison = try compareUpdateVersions("0.4.10", "0.4.9")
        precondition(comparison == 1)
        let same = try selectNativeUpdate(release(), current: "0.4.8")
        precondition(same == nil)
        var both = release(); both["assets"] = [asset(), asset("notarized")]
        let preferred = try selectNativeUpdate(both, current: "0.4.7")
        precondition(preferred?.url.hasSuffix("-notarized.zip") == true)
        for (key, value) in [("prerelease", true as Any), ("draft", true as Any), ("tag_name", "v0.4.8-beta" as Any)] {
            var invalid = release(); invalid[key] = value
            expectFailure { _ = try selectNativeUpdate(invalid, current: "0.4.7") }
        }
        for (key, value) in [("digest", NSNull() as Any), ("browser_download_url", "https://example.com/app.zip" as Any), ("size", 400 * 1024 * 1024 as Any), ("size", 1.5 as Any), ("size", true as Any)] {
            var invalidAsset = asset(); invalidAsset[key] = value
            var invalid = release(); invalid["assets"] = [invalidAsset]
            expectFailure { _ = try selectNativeUpdate(invalid, current: "0.4.7") }
        }
        try validateNativeArchivePaths(["aBridge.app/", "aBridge.app/Contents/Info.plist"])
        for path in ["../escape", "/aBridge.app/Contents", "aBridge.app/../../escape", "aBridge.app/./bad", "other.app/Contents", "aBridge.app/..\\escape"] {
            expectFailure { try validateNativeArchivePaths([path]) }
        }
        print("PASS native updater versions, official assets, digest requirement, bounded size, archive traversal")
    }
}
