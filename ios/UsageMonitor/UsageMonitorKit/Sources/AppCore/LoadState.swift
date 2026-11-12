import Foundation
import Networking

/// A generic four-phase load state used by every feature store/view-model, so
/// screens render loading / loaded / error consistently.
public enum LoadState<Value: Sendable>: Sendable {
    case idle
    case loading
    case loaded(Value)
    case failed(APIError)

    public var value: Value? {
        if case let .loaded(value) = self { return value }
        return nil
    }

    public var error: APIError? {
        if case let .failed(error) = self { return error }
        return nil
    }

    public var isLoading: Bool {
        if case .loading = self { return true }
        return false
    }

    /// True while loading AND we have nothing to show yet (drives skeleton vs.
    /// inline refresh spinner decisions).
    public var isInitialLoading: Bool {
        if case .loading = self { return true }
        if case .idle = self { return true }
        return false
    }
}

extension LoadState: Equatable where Value: Equatable {}
