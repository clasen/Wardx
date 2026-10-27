import Foundation
@testable import Wardx

let repositoryRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()

func testOptions(_ configure: (inout WardxOptions) -> Void = { _ in }) -> WardxOptions {
    var options = WardxOptions(
        endpoint: "http://127.0.0.1:1",
        projectKey: "test-key",
        project: "demo",
        role: "swift",
        appVersion: "1.0.0",
        environment: "test",
        privacySalt: "test-salt"
    )
    options.httpTimeoutMs = 5000
    configure(&options)
    return options
}

func testSettings(_ configure: (inout WardxOptions) -> Void = { _ in }) throws -> Settings {
    try Settings.resolve(testOptions(configure))
}

func messageDelay() -> ExperimentDefinition {
    ExperimentDefinition(
        id: "message-delay-v1",
        enabled: true,
        allocation: 1,
        salt: "3ad8f9",
        goalMetric: "message.sent",
        primaryMetric: "message.sent",
        variants: [
            VariantDefinition(key: "control", weight: 50, values: ["message.delayMs": .number(1000)]),
            VariantDefinition(key: "fast", weight: 50, values: ["message.delayMs": .number(400)])
        ]
    )
}

func temporaryPath(_ name: String) -> String {
    FileManager.default.temporaryDirectory
        .appendingPathComponent("wardx-swift-tests-\(UUID().uuidString)")
        .appendingPathComponent(name)
        .path
}

func events(_ batch: FrameBatch) -> [EventSample] {
    batch.frames.flatMap(\.events)
}

/// Records each decompressed envelope and answers with a stamped response.
final class MemoryTransport: SyncTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var envelopes: [String] = []
    private var closes = 0
    var respond: @Sendable (Int, String) -> SyncResult

    init(respond: @escaping @Sendable (Int, String) -> SyncResult = { _, _ in MemoryTransport.ok() }) {
        self.respond = respond
    }

    static func ok(_ extra: String = "\"configVersion\":0", serverTime: Int64 = Clock.unixMs()) -> SyncResult {
        SyncResult(ok: true, status: 200, text: "{\"ok\":true,\"serverTime\":\(serverTime),\(extra)}")
    }

    var jsons: [String] { lock.withLock { envelopes } }
    var closeCount: Int { lock.withLock { closes } }

    func clear() {
        lock.withLock { envelopes.removeAll() }
    }

    func post(_ gzippedBody: Data) async throws -> SyncResult {
        let json = String(decoding: try Gzip.decompress(gzippedBody), as: UTF8.self)
        let index = lock.withLock {
            envelopes.append(json)
            return envelopes.count
        }
        return respond(index, json)
    }

    func close() {
        lock.withLock { closes += 1 }
    }
}

/// Blocks the first post until released, to observe queue coalescing.
final class StallingTransport: SyncTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var envelopes: [String] = []
    private var active = 0
    private var maxActiveCount = 0
    private var closes = 0
    private var release: CheckedContinuation<Void, Never>?
    private var released = false
    private var started: CheckedContinuation<Void, Never>?
    private var hasStarted = false

    var jsons: [String] { lock.withLock { envelopes } }
    var maxActive: Int { lock.withLock { maxActiveCount } }
    var closeCount: Int { lock.withLock { closes } }

    func waitStarted() async {
        await withCheckedContinuation { continuation in
            let ready = lock.withLock {
                if hasStarted { return true }
                started = continuation
                return false
            }
            if ready { continuation.resume() }
        }
    }

    func releaseFirst() {
        let pending = lock.withLock {
            released = true
            defer { release = nil }
            return release
        }
        pending?.resume()
    }

    func post(_ gzippedBody: Data) async throws -> SyncResult {
        let json = String(decoding: try Gzip.decompress(gzippedBody), as: UTF8.self)
        let (first, notify) = lock.withLock {
            envelopes.append(json)
            active += 1
            maxActiveCount = max(maxActiveCount, active)
            let first = envelopes.count == 1
            if first { hasStarted = true }
            defer { if first { started = nil } }
            return (first, first ? started : nil)
        }
        notify?.resume()
        if first {
            await withCheckedContinuation { continuation in
                let go = lock.withLock {
                    if released { return true }
                    release = continuation
                    return false
                }
                if go { continuation.resume() }
            }
        }
        lock.withLock { active -= 1 }
        return first ? SyncResult(ok: false, status: 503, text: nil) : MemoryTransport.ok()
    }

    func close() {
        lock.withLock { closes += 1 }
    }
}

func parse(_ json: String) throws -> JSONValue {
    try JSON.parse(json)
}

func frames(_ envelope: String) throws -> [JSONValue] {
    try parse(envelope)["frames"]?.arrayValue ?? []
}

func aligned(_ options: WardxOptions, _ transport: any SyncTransport) throws -> WardxClient {
    let client = try WardxClient.create(options, transport: transport)
    let now = Clock.unixMs()
    client.core!.alignClock(serverTime: now, sentAt: now, receivedAt: now)
    return client
}
