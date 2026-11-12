import Foundation

public enum QuotaClientError: Error, Equatable, Sendable {
    case invalidEndpoint
    case invalidToken
    case timedOut
    case unauthorized
    case httpStatus(Int)
    case responseTooLarge
    case malformedResponse
    case transport
}

extension QuotaClientError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .invalidEndpoint: return "The quota endpoint URL is not allowed."
        case .invalidToken: return "The quota token is empty."
        case .timedOut: return "The quota request timed out."
        case .unauthorized: return "The quota request was unauthorized."
        case let .httpStatus(status): return "The quota server returned HTTP \(status)."
        case .responseTooLarge: return "The quota response is too large."
        case .malformedResponse: return "The quota response was malformed."
        case .transport: return "The quota request could not be completed."
        }
    }
}

/// A small, bearer-safe client for the Usage Monitor quota endpoint.
///
/// The session is always ephemeral and follows no redirects.  This prevents a
/// bearer token from being copied to a different origin by URLSession.
public actor QuotaClient {
    public let endpoint: URL
    private let token: String
    private let timeout: TimeInterval
    private let maxResponseBytes: Int
    private let session: URLSession
    private let delegate: QuotaSessionDelegate

    public init(
        endpoint: URL,
        token: String,
        timeout: TimeInterval = 15,
        maxResponseBytes: Int = 1_048_576,
        urlProtocolClasses: [AnyClass]? = nil
    ) throws {
        guard QuotaClient.isAllowedEndpoint(endpoint) else { throw QuotaClientError.invalidEndpoint }
        guard !token.isEmpty, !token.contains("\r"), !token.contains("\n") else { throw QuotaClientError.invalidToken }
        guard timeout > 0, timeout.isFinite, maxResponseBytes > 0 else { throw QuotaClientError.invalidEndpoint }

        self.endpoint = endpoint
        self.token = token
        self.timeout = timeout
        self.maxResponseBytes = maxResponseBytes
        let delegate = QuotaSessionDelegate()
        self.delegate = delegate
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout
        if let urlProtocolClasses { configuration.protocolClasses = urlProtocolClasses }
        self.session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    }

    deinit {
        session.invalidateAndCancel()
    }

    /// Fetches and validates one response.  No response body or underlying
    /// transport error is logged or included in the public error value.
    public func fetch() async throws -> QuotaResponse {
        var request = URLRequest(url: endpoint)
        request.httpMethod = "GET"
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        do {
            let (data, http) = try await perform(request)
            guard (200..<300).contains(http.statusCode) else {
                if http.statusCode == 401 { throw QuotaClientError.unauthorized }
                throw QuotaClientError.httpStatus(http.statusCode)
            }
            guard data.count <= maxResponseBytes else { throw QuotaClientError.responseTooLarge }
            do {
                return try JSONDecoder().decode(QuotaResponse.self, from: data)
            } catch {
                throw QuotaClientError.malformedResponse
            }
        } catch let error as QuotaClientError {
            throw error
        } catch is CancellationError {
            throw CancellationError()
        } catch let urlError as URLError where urlError.code == .timedOut {
            throw QuotaClientError.timedOut
        } catch {
            throw QuotaClientError.transport
        }
    }

    private func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let taskBox = RequestTaskBox()
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                let collector = ResponseCollector(maxBytes: maxResponseBytes, continuation: continuation)
                let task = session.dataTask(with: request)
                delegate.register(collector, for: task.taskIdentifier)
                taskBox.set(task)
                task.resume()
            }
        }, onCancel: {
            taskBox.cancel()
        })
    }

    public static func isAllowedEndpoint(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(),
              !host.isEmpty,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil else { return false }

        if scheme == "https" { return true }
        // Foundation versions differ on whether literal IPv6 retains brackets.
        let loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
        guard loopback else { return false }
        return scheme == "http"
    }
}

private final class QuotaSessionDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var collectors: [Int: ResponseCollector] = [:]

    func register(_ collector: ResponseCollector, for taskIdentifier: Int) {
        lock.lock()
        collectors[taskIdentifier] = collector
        lock.unlock()
    }

    private func collector(for taskIdentifier: Int) -> ResponseCollector? {
        lock.lock()
        defer { lock.unlock() }
        return collectors[taskIdentifier]
    }

    private func remove(_ taskIdentifier: Int) -> ResponseCollector? {
        lock.lock()
        defer { lock.unlock() }
        return collectors.removeValue(forKey: taskIdentifier)
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        remove(task.taskIdentifier)?.finish(.failure(QuotaClientError.httpStatus(response.statusCode)))
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let collector = collector(for: dataTask.taskIdentifier), let http = response as? HTTPURLResponse else {
            completionHandler(.cancel)
            return
        }
        if http.expectedContentLength > collector.maxBytes {
            remove(dataTask.taskIdentifier)?.finish(.failure(QuotaClientError.responseTooLarge))
            completionHandler(.cancel)
        } else {
            collector.response = http
            completionHandler(.allow)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        collector(for: dataTask.taskIdentifier)?.append(data, task: dataTask, delegate: self)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let collector = remove(task.taskIdentifier) else { return }
        if let error {
            if (error as? URLError)?.code == .cancelled {
                collector.finish(.failure(CancellationError()))
            } else {
                collector.finish(.failure((error as? URLError)?.code == .timedOut ? QuotaClientError.timedOut : QuotaClientError.transport))
            }
        } else {
            collector.complete()
        }
    }
}

private final class RequestTaskBox: @unchecked Sendable {
    private let lock = NSLock()
    private var task: URLSessionDataTask?
    private var cancelled = false

    func set(_ task: URLSessionDataTask) {
        lock.lock()
        if cancelled {
            lock.unlock()
            task.cancel()
            return
        }
        self.task = task
        lock.unlock()
    }

    func cancel() {
        lock.lock()
        cancelled = true
        let task = self.task
        lock.unlock()
        task?.cancel()
    }
}

private final class ResponseCollector: @unchecked Sendable {
    let maxBytes: Int
    private let lock = NSLock()
    private var data = Data()
    private var continuation: CheckedContinuation<(Data, HTTPURLResponse), Error>?
    private var completed = false
    var response: HTTPURLResponse?

    init(maxBytes: Int, continuation: CheckedContinuation<(Data, HTTPURLResponse), Error>) {
        self.maxBytes = maxBytes
        self.continuation = continuation
    }

    func append(_ chunk: Data, task: URLSessionDataTask, delegate: QuotaSessionDelegate) {
        lock.lock()
        guard !completed else { lock.unlock(); return }
        if data.count > maxBytes - chunk.count {
            completed = true
            let continuation = self.continuation
            self.continuation = nil
            lock.unlock()
            task.cancel()
            continuation?.resume(throwing: QuotaClientError.responseTooLarge)
            return
        }
        data.append(chunk)
        lock.unlock()
    }

    func complete() {
        lock.lock()
        guard !completed else { lock.unlock(); return }
        completed = true
        let continuation = self.continuation
        self.continuation = nil
        let result = response.map { (data, $0) }
        lock.unlock()
        guard let result else {
            continuation?.resume(throwing: QuotaClientError.transport)
            return
        }
        continuation?.resume(returning: result)
    }

    func finish(_ result: Result<(Data, HTTPURLResponse), Error>) {
        lock.lock()
        guard !completed else { lock.unlock(); return }
        completed = true
        let continuation = self.continuation
        self.continuation = nil
        lock.unlock()
        continuation?.resume(with: result)
    }
}
