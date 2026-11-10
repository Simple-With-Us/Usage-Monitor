import Darwin
import Foundation

/// Runs a quota-only helper without a shell, interactive input, or unbounded pipes.
final class BoundedQuotaProcess: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false

    func run(path: String, arguments: [String], home: URL, timeout: TimeInterval = 30,
             maxBytes: Int = 262_144) async throws -> Data {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                DispatchQueue.global(qos: .utility).async {
                    continuation.resume(with: Result {
                        try self.runBlocking(path: path, arguments: arguments, home: home, timeout: timeout, maxBytes: maxBytes)
                    })
                }
            }
        } onCancel: {
            self.lock.lock(); self.cancelled = true; self.lock.unlock()
        }
    }

    private var isCancelled: Bool {
        lock.lock(); defer { lock.unlock() }; return cancelled
    }

    private func runBlocking(path: String, arguments: [String], home: URL,
                             timeout: TimeInterval, maxBytes: Int) throws -> Data {
        guard !isCancelled else { throw CancellationError() }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = arguments
        process.environment = ["HOME": home.path,
                               "PATH": "\(home.path)/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
                               "NO_COLOR": "1"]
        process.standardInput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        let output = Pipe()
        process.standardOutput = output
        let reader = output.fileHandleForReading
        defer { try? reader.close() }
        try process.run()
        try? output.fileHandleForWriting.close()
        let descriptor = reader.fileDescriptor
        _ = fcntl(descriptor, F_SETFL, fcntl(descriptor, F_GETFL) | O_NONBLOCK)
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        do {
            while true {
                if isCancelled { throw CancellationError() }
                if ProcessInfo.processInfo.systemUptime >= deadline { throw Failure.timedOut }
                let count = Darwin.read(descriptor, &buffer, buffer.count)
                if count > 0 {
                    guard data.count + count <= maxBytes else { throw Failure.tooLarge }
                    data.append(contentsOf: buffer.prefix(count))
                    continue
                }
                if count < 0 && errno != EAGAIN && errno != EINTR { throw Failure.unavailable }
                if !process.isRunning { break }
                Thread.sleep(forTimeInterval: 0.03)
            }
            guard process.terminationStatus == 0 else { throw Failure.unavailable }
            return data
        } catch {
            if process.isRunning {
                process.terminate()
                let stopDeadline = ProcessInfo.processInfo.systemUptime + 0.5
                while process.isRunning && ProcessInfo.processInfo.systemUptime < stopDeadline {
                    Thread.sleep(forTimeInterval: 0.02)
                }
                if process.isRunning { _ = Darwin.kill(process.processIdentifier, SIGKILL) }
            }
            throw error
        }
    }

    private enum Failure: Error { case timedOut, tooLarge, unavailable }
}
