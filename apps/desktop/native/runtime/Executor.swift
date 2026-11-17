import Foundation
import Darwin

private func localFailure(_ code: Int32 = errno) -> DesktopError {
    let names: [Int32: String] = [ENOENT: "ENOENT", EEXIST: "EEXIST", EACCES: "EACCES", EPERM: "EPERM", ENOTDIR: "ENOTDIR", EISDIR: "EISDIR", ENXIO: "ENXIO", EIO: "EIO", ENOSPC: "ENOSPC", ELOOP: "ELOOP"]
    return DesktopError(code: "execution_failed", message: "Local command/file access failed (\(names[code] ?? "OS_ERROR"))", outcome: "failed")
}

private final class ShellGroup: @unchecked Sendable {
    private let lock = NSLock()
    let pid: pid_t
    private var killed = false
    private var expired = false
    private var done = false
    init(pid: pid_t) { self.pid = pid }
    func terminate(timeout: Bool = false) {
        lock.lock(); expired = expired || timeout
        if killed { lock.unlock(); return }; killed = true
        Darwin.kill(-pid, SIGTERM)
        lock.unlock()
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.15) { Darwin.kill(-self.pid, SIGKILL) }
    }
    func markDone() { lock.lock(); done = true; lock.unlock() }
    var isDone: Bool { lock.lock(); defer { lock.unlock() }; return done }
    var timedOut: Bool { lock.lock(); defer { lock.unlock() }; return expired }
}
private struct ShellCapture: Sendable { let data: Data; let truncated: Bool }

/// POSIX process groups retain cancellation semantics without a Node child-process host.
enum NativeShell {
    private static func capture(_ fd: Int32, group: ShellGroup, emit: @escaping @Sendable (Data) -> Void) async -> ShellCapture {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                defer { Darwin.close(fd) }
                _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
                var data = Data(), truncated = false, buffer = [UInt8](repeating: 0, count: 8192)
                while true {
                    let count = Darwin.read(fd, &buffer, buffer.count)
                    if count > 0 {
                        let accepted = min(count, max(0, 131072 - data.count))
                        if accepted > 0 { let chunk = Data(buffer.prefix(accepted)); data.append(chunk); emit(chunk) }
                        if accepted < count { truncated = true }
                    } else if count == 0 { break }
                    else if errno == EINTR { continue }
                    else if errno == EAGAIN || errno == EWOULDBLOCK {
                        if group.isDone { break }
                        var descriptor = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
                        _ = poll(&descriptor, 1, 100)
                    } else { break }
                }
                continuation.resume(returning: ShellCapture(data: data, truncated: truncated))
            }
        }
    }
    private static func consume(_ stream: AsyncStream<Data>, channel: String, output: (@Sendable (String, String) async -> Void)?) async {
        var pending = Data()
        for await chunk in stream {
            pending.append(chunk)
            // Keep only a possibly incomplete UTF-8 suffix; invalid complete sequences use U+FFFD.
            var end = pending.count
            if !pending.isEmpty {
                var start = pending.count - 1
                while start > 0 && pending[start] & 0xC0 == 0x80 { start -= 1 }
                let lead = pending[start]
                let expected = lead < 0x80 ? 1 : lead >= 0xC2 && lead <= 0xDF ? 2 : lead >= 0xE0 && lead <= 0xEF ? 3 : lead >= 0xF0 && lead <= 0xF4 ? 4 : 1
                if pending.count - start < expected { end = start }
            }
            if end > 0 {
                let text = String(decoding: pending.prefix(end), as: UTF8.self)
                pending = Data(pending.dropFirst(end))
                if !Task.isCancelled { await output?(channel, text) }
            }
        }
        if !pending.isEmpty, !Task.isCancelled { await output?(channel, String(decoding: pending, as: UTF8.self)) }
    }
    static func run(executable: String, arguments: [String], cwd: String, environment: [String: String], timeout: Double, output: (@Sendable (String, String) async -> Void)?) async throws -> JSONObject {
        try Task.checkCancellation()
        var out = [Int32](repeating: -1, count: 2), err = out
        guard pipe(&out) == 0 else { throw localFailure() }
        guard pipe(&err) == 0 else { let error = localFailure(); out.forEach { Darwin.close($0) }; throw error }
        for fd in out + err { _ = fcntl(fd, F_SETFD, FD_CLOEXEC) }
        var actions: posix_spawn_file_actions_t?, attributes: posix_spawnattr_t?
        posix_spawn_file_actions_init(&actions); posix_spawnattr_init(&attributes)
        defer { posix_spawn_file_actions_destroy(&actions); posix_spawnattr_destroy(&attributes) }
        posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_adddup2(&actions, out[1], STDOUT_FILENO)
        posix_spawn_file_actions_adddup2(&actions, err[1], STDERR_FILENO)
        for fd in out + err { posix_spawn_file_actions_addclose(&actions, fd) }
        posix_spawn_file_actions_addchdir_np(&actions, cwd)
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP))
        posix_spawnattr_setpgroup(&attributes, 0)
        let argv = ([executable] + arguments).map { strdup($0) } + [nil]
        let env = environment.sorted { $0.key < $1.key }.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer { argv.forEach { free($0) }; env.forEach { free($0) } }
        var pid: pid_t = 0
        let status = argv.withUnsafeBufferPointer { a in env.withUnsafeBufferPointer { e in posix_spawn(&pid, executable, &actions, &attributes, a.baseAddress!, e.baseAddress!) } }
        Darwin.close(out[1]); Darwin.close(err[1])
        if status != 0 { Darwin.close(out[0]); Darwin.close(err[0]); throw localFailure(status) }
        let group = ShellGroup(pid: pid)
        let outFD = out[0], errFD = err[0]
        let stdout = AsyncStream<Data>.makeStream(), stderr = AsyncStream<Data>.makeStream()
        let stdoutOutput = Task { await consume(stdout.stream, channel: "stdout", output: output) }
        let stderrOutput = Task { await consume(stderr.stream, channel: "stderr", output: output) }
        let timer = Task { try? await Task.sleep(nanoseconds: UInt64(max(1, timeout) * 1_000_000)); if !Task.isCancelled { group.terminate(timeout: true) } }
        defer { timer.cancel() }
        return try await withTaskCancellationHandler {
            async let outCapture = capture(outFD, group: group) { stdout.continuation.yield($0) }
            async let errCapture = capture(errFD, group: group) { stderr.continuation.yield($0) }
            let waitStatus: Int32 = await withCheckedContinuation { continuation in
                DispatchQueue.global(qos: .userInitiated).async {
                    var result: Int32 = 0
                    while waitpid(group.pid, &result, 0) < 0 { if errno != EINTR { result = -1; break } }
                    continuation.resume(returning: result)
                }
            }
            timer.cancel()
            group.terminate() // Clean up background children even when the shell exits first.
            // Cleanup must complete even when this task has already been cancelled.
            await Task.detached { try? await Task.sleep(nanoseconds: 160_000_000) }.value
            group.markDone()
            let (capturedOut, capturedErr) = await (outCapture, errCapture)
            stdout.continuation.finish(); stderr.continuation.finish()
            await stdoutOutput.value; await stderrOutput.value
            try Task.checkCancellation()
            let exitedNormally = waitStatus >= 0 && (waitStatus & 0x7f) == 0
            return ["exit_code": .number(exitedNormally ? Double((waitStatus >> 8) & 0xff) : -1), "stdout": .string(String(decoding: capturedOut.data, as: UTF8.self)), "stderr": .string(String(decoding: capturedErr.data, as: UTF8.self)), "truncated": .bool(capturedOut.truncated || capturedErr.truncated), "timed_out": .bool(group.timedOut)]
        } onCancel: {
            stdoutOutput.cancel(); stderrOutput.cancel(); group.terminate()
        }
    }
}

actor NativeExecutor {
    private let native: any DesktopNativeDriver
    private let computer: NativeComputer
    private let output: (@Sendable (String, String, String) async -> Void)?
    private var running: [String: (UUID, String, Task<JSONObject, Error>)] = [:]
    init(output: (@Sendable (String, String, String) async -> Void)? = nil) {
        let driver = NativeDriver(); native = driver; computer = NativeComputer(native: driver); self.output = output
    }
    init(native: any DesktopNativeDriver, output: (@Sendable (String, String, String) async -> Void)? = nil) { self.native = native; computer = NativeComputer(native: native); self.output = output }
    func execute(id: String, session: String, tool: String, arguments: JSONObject) async throws -> JSONObject {
        try Task.checkCancellation()
        let key = UUID(), output = self.output, computer = self.computer
        let task = Task {
            if tool.hasPrefix("computer_") { return try await computer.execute(session: session, tool: tool, arguments: arguments) }
            switch tool {
            case "command_execute":
                let cwd = Self.path(arguments.string("cwd") ?? NSHomeDirectory())
                var info = stat()
                guard fstatat(AT_FDCWD, cwd, &info, 0) == 0, info.st_mode & S_IFMT == S_IFDIR else { throw DesktopError(code: "invalid_cwd", message: "Command working directory must be an existing directory") }
                guard let command = arguments.string("command") else { throw DesktopError(code: "invalid_arguments", message: "Missing command") }
                var environment = ProcessInfo.processInfo.environment.filter { ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR"].contains($0.key) }
                for (key, value) in arguments.object("env") ?? [:] { if let text = value.string { environment[key] = text } }
                return try await NativeShell.run(executable: "/bin/sh", arguments: ["-c", command], cwd: cwd, environment: environment, timeout: (arguments.number("timeout") ?? 30) * 1000, output: { channel, text in await output?(id, channel, text) })
            case "files_list": return try Self.list(arguments)
            case "file_read": return try Self.read(arguments)
            case "file_write": return try Self.write(arguments)
            default: throw DesktopError(code: "unsupported_tool", message: "Unsupported local tool")
            }
        }
        running[id] = (key, session, task)
        defer { if running[id]?.0 == key { running.removeValue(forKey: id) } }
        return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    }
    private static func path(_ input: String) -> String { URL(fileURLWithPath: (input as NSString).expandingTildeInPath).standardizedFileURL.path }
    private static func list(_ args: JSONObject) throws -> JSONObject {
        let path = path(args.string("path") ?? ""), limit = max(1, min(500, Int(args.number("limit") ?? 200)))
        guard let directory = opendir(path) else { throw localFailure() }; defer { closedir(directory) }
        var entries: [JSONObject] = [], truncated = false
        while true {
            try Task.checkCancellation(); errno = 0
            guard let item = readdir(directory) else { if errno != 0 { throw localFailure() }; break }
            let name = withUnsafePointer(to: &item.pointee.d_name) { pointer in pointer.withMemoryRebound(to: CChar.self, capacity: Int(item.pointee.d_namlen) + 1) { String(cString: $0) } }
            if name == "." || name == ".." { continue }
            if entries.count >= limit { truncated = true; break }
            var info = stat()
            guard fstatat(dirfd(directory), name, &info, AT_SYMLINK_NOFOLLOW) == 0 else { throw localFailure() }
            entries.append(["name": .string(name), "is_directory": .bool(info.st_mode & S_IFMT == S_IFDIR), "is_symlink": .bool(info.st_mode & S_IFMT == S_IFLNK), "size": .number(Double(info.st_size)), "modified_at": .number(Double(info.st_mtimespec.tv_sec) + Double(info.st_mtimespec.tv_nsec) / 1_000_000_000)])
        }
        entries.sort { ($0.string("name") ?? "").localizedCaseInsensitiveCompare($1.string("name") ?? "") == .orderedAscending }
        return ["path": .string(path), "entries": .array(entries.map(JSONValue.object)), "truncated": .bool(truncated)]
    }
    private static func read(_ args: JSONObject) throws -> JSONObject {
        let path = path(args.string("path") ?? ""), limit = max(1, min(1_048_576, Int(args.number("max_bytes") ?? 1_048_576)))
        let fd = Darwin.open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw localFailure() }; defer { Darwin.close(fd) }
        var info = stat(); guard fstat(fd, &info) == 0 else { throw localFailure() }
        guard info.st_mode & S_IFMT == S_IFREG else { throw DesktopError(code: "unsupported_file_type", message: "Only regular files can be read") }
        var content = Data(), buffer = [UInt8](repeating: 0, count: 65536)
        while content.count <= limit {
            try Task.checkCancellation()
            let count = Darwin.read(fd, &buffer, min(buffer.count, limit + 1 - content.count))
            if count == 0 { break }
            if count < 0 { if errno == EINTR { continue }; throw localFailure() }
            content.append(contentsOf: buffer.prefix(count))
        }
        if content.count > limit { throw DesktopError(code: "file_too_large", message: "File exceeds the requested size limit") }
        guard let text = String(data: content, encoding: .utf8) else { throw DesktopError(code: "unsupported_encoding", message: "File is not valid UTF-8") }
        return ["path": .string(path), "content": .string(text), "size": .number(Double(content.count))]
    }
    private static func write(_ args: JSONObject) throws -> JSONObject {
        let path = path(args.string("path") ?? ""), data = Data((args.string("content") ?? "").utf8), overwrite = args.bool("overwrite") ?? false
        guard data.count <= 1_048_576 else { throw DesktopError(code: "invalid_arguments", message: "Content exceeds the one MiB size limit") }
        try Task.checkCancellation()
        let fd = Darwin.open(path, O_WRONLY | O_CREAT | O_NONBLOCK | O_CLOEXEC | (overwrite ? 0 : O_EXCL), mode_t(0o666))
        guard fd >= 0 else { throw localFailure() }; defer { Darwin.close(fd) }
        var info = stat(); guard fstat(fd, &info) == 0 else { throw localFailure() }
        guard info.st_mode & S_IFMT == S_IFREG else { throw DesktopError(code: "unsupported_file_type", message: "Only regular files can be written") }
        try Task.checkCancellation()
        if overwrite && ftruncate(fd, 0) != 0 { throw localFailure() }
        try data.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                try Task.checkCancellation()
                let count = Darwin.write(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                if count < 0 { if errno == EINTR { continue }; throw localFailure() }
                if count == 0 { throw localFailure(EIO) }; offset += count
            }
        }
        return ["path": .string(path), "size": .number(Double(data.count)), "overwritten": .bool(overwrite)]
    }
    func diagnostics(initialize: Bool = true) async -> JSONObject {
        var info = await native.diagnostics(initialize: initialize)
        info["runtime"] = .object(["native": .bool(true), "ready": .bool(true)])
        return info
    }
    func smoke() async throws -> JSONObject { try await NativeDriver.smoke() }
    func closeSession(_ id: String) async {
        let tasks = running.values.filter { $0.1 == id }.map(\.2)
        tasks.forEach { $0.cancel() }; await computer.closeSession(id)
        for task in tasks { _ = try? await task.value }
    }
    func stop() async {
        let tasks = running.values.map(\.2); tasks.forEach { $0.cancel() }
        await computer.stop(); for task in tasks { _ = try? await task.value }
    }
    func stopComputer() async { await computer.stop() }
    func shutdown() async { await stop(); await computer.shutdown() }
}
