import Foundation
@main struct ContractFixture {
    static func main() throws {
        let contract = try NativeContract.load(path: CommandLine.arguments[1])
        while let line = readLine() {
            do {
                guard let input = try JSONValue.decode(Data(line.utf8)).object, let name = input.string("schema"), let value = input.object("value") else { throw DesktopError(code: "invalid_arguments", message: "Fixture input") }
                emitJSON(["ok": .bool(true), "value": .object(try contract.validate(name, value))])
            } catch { emitJSON(["ok": .bool(false)]) }
        }
    }
}
