import Foundation

/// Typed, user-presentable failure surface for every ``APIClient`` call.
///
/// Feature view-models switch on these to render an appropriate
/// `ErrorState` (retry vs. "add your token" vs. "server misconfigured").
public enum APIError: Error, Equatable, Sendable {
    /// No API token has been stored yet — the app must prompt the user to add
    /// one in Settings before any authenticated call can succeed.
    case missingToken
    /// 401 — the stored token was rejected. Usually means the token is wrong
    /// or was rotated on the server.
    case unauthorized
    /// 403 — authenticated but not allowed (should not normally happen for the
    /// read endpoints this app uses).
    case forbidden
    /// 503 — the server has no read token configured, so budget status is
    /// unavailable regardless of the client token.
    case serverNotConfigured
    /// 429 — rate limited. `retryAfter` is seconds, when the server provided it.
    case rateLimited(retryAfter: TimeInterval?)
    /// Any other non-2xx HTTP status.
    case httpStatus(Int)
    /// The response body could not be decoded into the expected model.
    case decoding(String)
    /// The device is offline / the request could not reach the server.
    case offline
    /// A transport-level error that isn't specifically "offline".
    case transport(String)

    /// A short, human-facing headline suitable for an `ErrorState` title.
    public var title: String {
        switch self {
        case .missingToken: return "No API token"
        case .unauthorized: return "Sign-in rejected"
        case .forbidden: return "Access denied"
        case .serverNotConfigured: return "Server unavailable"
        case .rateLimited: return "Too many requests"
        case .httpStatus: return "Request failed"
        case .decoding: return "Unexpected response"
        case .offline: return "You're offline"
        case .transport: return "Connection problem"
        }
    }

    /// A one-line explanation with a suggested next step.
    public var message: String {
        switch self {
        case .missingToken:
            return "Add your usage read token in Settings to load budget data."
        case .unauthorized:
            return "Your read token or dashboard session was rejected. Reconnect or sign in again in Settings."
        case .forbidden:
            return "This credential isn't allowed to perform that action."
        case .serverNotConfigured:
            return "The monitor hasn't enabled read access yet. Try again later."
        case let .rateLimited(retryAfter):
            if let retryAfter {
                return "Please wait \(Int(retryAfter))s before refreshing again."
            }
            return "You're refreshing too quickly. Wait a moment and try again."
        case let .httpStatus(code):
            return "The server responded with an unexpected status (\(code))."
        case let .decoding(detail):
            return "The server sent data the app couldn't read. \(detail)"
        case .offline:
            return "Check your internet connection and pull to refresh."
        case let .transport(detail):
            return "Couldn't reach the server. \(detail)"
        }
    }

    /// Whether a plain "Try again" affordance makes sense (vs. needing the user
    /// to fix their token / settings first).
    public var isRetryable: Bool {
        switch self {
        case .missingToken, .unauthorized, .forbidden, .serverNotConfigured:
            return false
        case .rateLimited, .httpStatus, .decoding, .offline, .transport:
            return true
        }
    }
}
