import Foundation
#if canImport(AppKit) && !targetEnvironment(macCatalyst)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

struct SdkIdentity: Sendable {
    let name: String
    let version: String
    let platform: String
    let os: String

    static let current = SdkIdentity(name: "wardx-swift", version: SdkDefaults.version, platform: "swift", os: Platform.osName)
}

enum Platform {
    static var osName: String {
        #if os(macOS) || targetEnvironment(macCatalyst)
        return "macos"
        #elseif os(iOS)
        return "ios"
        #elseif os(tvOS)
        return "tvos"
        #elseif os(watchOS)
        return "watchos"
        #elseif os(visionOS)
        return "visionos"
        #else
        return "unknown"
        #endif
    }

    static func residentBytes() -> Double {
        var info = mach_task_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size)
        let status = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
            }
        }
        return status == KERN_SUCCESS ? Double(info.resident_size) : 0
    }

    /// Default retained metrics file under Application Support, one per project and role.
    static func defaultRetainedPath(project: String, role: String) -> String {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let owner = Bundle.main.bundleIdentifier ?? ProcessInfo.processInfo.processName
        return support
            .appendingPathComponent(owner, isDirectory: true)
            .appendingPathComponent("wardx-retained-\(project)-\(role).json")
            .path
    }
}

/// Maps app lifecycle notifications onto the client: sleep or background cuts the frame window
/// and flushes, wake or foreground resumes it, and termination stops without a final flush.
final class LifecycleObserver: @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: [(NotificationCenter, NSObjectProtocol)] = []

    init(client: WardxClient) {
        #if canImport(AppKit) && !targetEnvironment(macCatalyst)
        let workspace = NSWorkspace.shared.notificationCenter
        observe(workspace, NSWorkspace.willSleepNotification) { [weak client] in _ = client?.suspend() }
        observe(workspace, NSWorkspace.didWakeNotification) { [weak client] in client?.resume() }
        observe(.default, NSApplication.willTerminateNotification) { [weak client] in client?.stop() }
        #elseif canImport(UIKit) && !os(watchOS)
        observe(.default, UIApplication.didEnterBackgroundNotification) { [weak client] in
            guard let client else { return }
            MainActor.assumeIsolated {
                let application = UIApplication.shared
                let background = BackgroundTask()
                background.identifier = application.beginBackgroundTask { background.end(application) }
                let flush = client.suspend()
                Task { @MainActor in
                    await flush.value
                    background.end(application)
                }
            }
        }
        observe(.default, UIApplication.willEnterForegroundNotification) { [weak client] in client?.resume() }
        observe(.default, UIApplication.willTerminateNotification) { [weak client] in client?.stop() }
        #endif
    }

    private func observe(_ center: NotificationCenter, _ name: Notification.Name, _ action: @escaping @Sendable () -> Void) {
        let token = center.addObserver(forName: name, object: nil, queue: .main) { _ in action() }
        lock.withLock { tokens.append((center, token)) }
    }

    func remove() {
        let removed = lock.withLock {
            defer { tokens = [] }
            return tokens
        }
        for (center, token) in removed { center.removeObserver(token) }
    }
}

#if canImport(UIKit) && !os(watchOS) && !(canImport(AppKit) && !targetEnvironment(macCatalyst))
/// Ends the background task once, whether the flush finishes or the system expires it first.
@MainActor
private final class BackgroundTask {
    var identifier = UIBackgroundTaskIdentifier.invalid

    func end(_ application: UIApplication) {
        guard identifier != .invalid else { return }
        application.endBackgroundTask(identifier)
        identifier = .invalid
    }
}
#endif
