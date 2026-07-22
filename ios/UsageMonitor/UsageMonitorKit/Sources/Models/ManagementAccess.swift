import Foundation

/// A stored bearer credential is intentionally described as configured rather
/// than verified: after relaunch, only a live read request can prove validity.
public enum BearerReadCapability: String, Codable, Hashable, Sendable {
    case notConfigured
    case configured
}

/// Server-validated dashboard-session state.
public enum DashboardSessionStatus: Hashable, Sendable {
    case signedOut
    case active(providerCount: Int)

    public var isActive: Bool {
        if case .active = self { return true }
        return false
    }

    public var providerCount: Int? {
        guard case let .active(providerCount) = self else { return nil }
        return providerCount
    }
}

/// The two independent credentials the native app can use.
public struct AccessCapabilities: Hashable, Sendable {
    public var bearerRead: BearerReadCapability
    public var sessionManagement: DashboardSessionStatus

    public init(
        bearerRead: BearerReadCapability,
        sessionManagement: DashboardSessionStatus
    ) {
        self.bearerRead = bearerRead
        self.sessionManagement = sessionManagement
    }

    public var canRead: Bool {
        bearerRead == .configured || sessionManagement.isActive
    }

    public var canManage: Bool {
        sessionManagement.isActive
    }
}

public struct DashboardLoginResponse: Codable, Hashable, Sendable {
    public var ok: Bool

    public init(ok: Bool) {
        self.ok = ok
    }
}

public struct DashboardLogoutResponse: Codable, Hashable, Sendable {
    public var ok: Bool

    public init(ok: Bool) {
        self.ok = ok
    }
}
