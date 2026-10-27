import Foundation
import Testing
@testable import Wardx

struct SyncTests {
    @Test func envelopeCarriesTheSwiftIdentity() async throws {
        let transport = MemoryTransport()
        let client = try aligned(testOptions { $0.attributes = ["tier": 2] }, transport)
        client.counter("requests", ["route": "/a"]).inc()
        client.event("app.opened", ["source": "dock"])
        client.log.error("failed", ["code": "E1"])
        await client.flush()
        let envelope = try parse(transport.jsons[0])
        #expect(envelope["protocol"] == .number(1))
        #expect(envelope["sdk"]?["name"] == .string("wardx-swift"))
        #expect(envelope["client"]?["platform"] == .string("swift"))
        #expect(envelope["client"]?["os"] == .string("macos"))
        #expect(envelope["client"]?["role"] == .string("swift"))
        #expect(envelope["client"]?["attributes"] == .object(["tier": .number(2)]))
        let frame = try #require(envelope["frames"]?.arrayValue?.first)
        #expect(frame["metrics"]?["counters"]?.arrayValue?.contains(.array([.string("requests"), .object(["route": .string("/a")]), .number(1)])) == true)
        #expect(frame["events"]?.arrayValue?.first?.arrayValue?[1] == .string("app.opened"))
        #expect(frame["logs"]?.arrayValue?.first?.arrayValue?[1] == .string("error"))
        await client.shutdown()
        #expect(transport.closeCount == 1)
    }

    @Test func framesWaitForTheServerClock() async throws {
        let deviceAheadMs: Int64 = 600_000
        let transport = MemoryTransport { _, _ in MemoryTransport.ok(serverTime: Clock.unixMs() - deviceAheadMs) }
        let client = try WardxClient.create(testOptions(), transport: transport)
        client.counter("before.alignment").inc()
        await client.enqueueSnapshot().value
        #expect(client.core!.takePendingFrames().isEmpty)

        let before = Clock.unixMs()
        await client.flush()
        let after = Clock.unixMs()
        #expect(transport.jsons.count == 2)
        #expect(try frames(transport.jsons[0]).isEmpty)
        let frame = try #require(try frames(transport.jsons[1]).first)
        let to = Int64(frame["to"]!.numberValue!)
        #expect(to >= before - deviceAheadMs - 1 && to <= after - deviceAheadMs + (after - before + 1))
        #expect(transport.jsons[1].contains("before.alignment"))
        await client.shutdown()
    }

    @Test func remoteConfigAppliesAndSendsTheContext() async throws {
        let transport = MemoryTransport { _, _ in
            MemoryTransport.ok("\"configVersion\":13,\"configContext\":\"eb73e4a74e3c94df\",\"config\":{\"values\":{\"message.delayMs\":1000,\"title\":\"hi\",\"layout\":{\"columns\":2}},\"experiments\":[]}")
        }
        let client = try WardxClient.create(testOptions(), transport: transport)
        #expect(client.config.get("message.delayMs", 7) == 7)
        await client.flush()
        #expect(client.config.get("message.delayMs", 7) == 1000)
        #expect(client.config.get("message.delayMs", 7.5) == 1000.0)
        #expect(client.config.get("title", "fallback") == "hi")
        #expect(client.config.get("title", 3) == 3)
        #expect(client.config.get("layout", JSONValue.null) == .object(["columns": .number(2)]))
        await client.flush()
        let last = try parse(transport.jsons.last!)
        #expect(last["configVersion"] == .number(13))
        #expect(last["configContext"] == .string("eb73e4a74e3c94df"))
        await client.shutdown()
    }

    @Test func failedSyncDropsTheBatchAndCountsIt() async throws {
        let transport = MemoryTransport { index, _ in
            index == 1 ? SyncResult(ok: false, status: 503, text: nil) : MemoryTransport.ok()
        }
        let client = try aligned(testOptions(), transport)
        client.counter("lost").inc()
        await client.flush()
        client.counter("kept").inc()
        await client.flush()
        let recovery = transport.jsons[1]
        #expect(!recovery.contains("\"lost\""))
        #expect(recovery.contains("\"kept\""))
        #expect(recovery.contains("[\"wardx.internal.frames_failed\",null,1]"))
        await client.shutdown()
    }

    @Test func missingServerTimeFailsTheSync() async throws {
        let transport = MemoryTransport { _, _ in SyncResult(ok: true, status: 200, text: "{\"ok\":true,\"configVersion\":0}") }
        let client = try WardxClient.create(testOptions(), transport: transport)
        client.counter("never.aligned").inc()
        await client.flush()
        #expect(transport.jsons.count == 1)
        #expect(client.core!.clockAligned == false)
        #expect(client.core!.internalMetrics.framesFailed >= 1)
        await client.shutdown()
    }

    @Test func envelopesRespectServerLimits() async throws {
        let transport = MemoryTransport { index, _ in
            index == 2 ? SyncResult(ok: false, status: 503, text: nil) : MemoryTransport.ok()
        }
        let client = try aligned(testOptions {
            $0.maxFrameBytes = 2048
            $0.maxEnvelopeBytes = 8192
            $0.maxEnvelopeItems = 25
        }, transport)
        let text = WardxValue(String(repeating: "x", count: 100))
        for index in 0..<200 { client.event("sized", ["i": WardxValue(index), "text": text]) }
        await client.flush()
        #expect(transport.jsons.count == 2)
        transport.respond = { _, _ in MemoryTransport.ok() }
        let delivered = try frames(transport.jsons[0])
        await client.flush()
        let recovery = try #require(try frames(transport.jsons[2]).first)
        let failed = recovery["metrics"]?["counters"]?.arrayValue?
            .first { $0.arrayValue?[0] == .string(WireProtocol.Internal.framesFailed) }?.arrayValue?[2].numberValue
        let unsent = recovery["seq"]!.numberValue! - delivered[0]["seq"]!.numberValue! - Double(delivered.count)
        #expect(unsent > 1)
        #expect(failed == unsent)

        transport.clear()
        for index in 0..<200 { client.event("sized", ["i": WardxValue(index), "text": text]) }
        await client.flush()
        #expect(transport.jsons.count > 1)
        var seqs: [Double] = []
        var order: [Double] = []
        for json in transport.jsons {
            #expect(json.utf8.count <= 8192)
            var items = 0
            for frame in try frames(json) {
                seqs.append(frame["seq"]!.numberValue!)
                for key in ["counters", "gauges", "histograms", "distincts"] { items += frame["metrics"]?[key]?.arrayValue?.count ?? 0 }
                items += frame["logs"]?.arrayValue?.count ?? 0
                for row in frame["events"]?.arrayValue ?? [] {
                    items += 1
                    order.append(row.arrayValue![2]["i"]!.numberValue!)
                }
            }
            #expect(items <= 25)
        }
        #expect(seqs == (0..<seqs.count).map { seqs[0] + Double($0) })
        #expect(order == (0..<200).map(Double.init))
        await client.shutdown()
    }

    @Test func flushStormCoalescesBehindAStalledSend() async throws {
        let transport = StallingTransport()
        let client = try aligned(testOptions(), transport)
        client.counter("lost-on-failure").inc()
        let first = client.enqueueSync(SyncFlags(flush: true))
        await transport.waitStarted()
        let counter = client.counter("operations")
        let pending = client.enqueueSync(SyncFlags())
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<1000 { group.addTask { counter.inc() } }
        }
        for _ in 0..<50 { _ = client.enqueueSync(SyncFlags(flush: true)) }
        client.event("pending-at-shutdown")
        #expect(transport.jsons.count == 1)
        let shutdown = Task { await client.shutdown() }
        transport.releaseFirst()
        await first.value
        await pending.value
        await shutdown.value
        let envelopes = transport.jsons
        #expect(envelopes.count == 3)
        #expect(transport.maxActive == 1)
        #expect(transport.closeCount == 1)
        #expect(envelopes[1].contains("[\"operations\",null,1000]"))
        #expect(envelopes[1].contains("pending-at-shutdown"))
        #expect(!envelopes[1].contains("lost-on-failure"))
        await client.flush()
        #expect(transport.jsons.count == 3)
    }

    @Test func suspensionFlushesTheCutWindow() async throws {
        let transport = MemoryTransport()
        let client = try aligned(testOptions(), transport)
        client.counter("before.pause").inc()
        let flush = client.suspend()
        let paused = Clock.unixMs()
        await flush.value
        #expect(transport.jsons.count == 1)
        let cut = try #require(try frames(transport.jsons[0]).first)
        #expect(cut["to"]!.numberValue! <= Double(paused))
        try await Task.sleep(nanoseconds: 30_000_000)
        let resuming = Clock.unixMs()
        client.resume()
        client.counter("after.resume").inc()
        await client.flush()
        let resumed = try #require(try frames(transport.jsons[1]).first)
        #expect(resumed["from"]!.numberValue! >= Double(resuming))
        await client.shutdown()
    }

    @Test func hangingTransportTimesOut() async throws {
        struct Hanging: SyncTransport {
            func post(_ gzippedBody: Data) async throws -> SyncResult {
                try await Task.sleep(nanoseconds: 60_000_000_000)
                return MemoryTransport.ok()
            }
            func close() {}
        }
        let client = try WardxClient.create(testOptions { $0.httpTimeoutMs = 100 }, transport: Hanging())
        let started = Clock.monotonicMs()
        await client.flush()
        #expect(Clock.monotonicMs() - started < 2000)
        #expect(client.core!.internalMetrics.framesFailed >= 1)
        client.stop()
    }

    @Test func timerRecordsElapsedMilliseconds() async throws {
        let transport = MemoryTransport()
        let client = try aligned(testOptions(), transport)
        let timer = client.timer("work", ["kind": "a"])
        try await Task.sleep(nanoseconds: 20_000_000)
        timer.stop(["result": "ok"])
        timer.stop()
        await client.flush()
        let histogram = try #require(try frames(transport.jsons[0]).first?["metrics"]?["histograms"]?.arrayValue?.first?.arrayValue)
        #expect(histogram[1] == .object(["kind": .string("a"), "result": .string("ok")]))
        #expect(histogram[2]["count"] == .number(1))
        #expect(histogram[2]["max"]!.numberValue! >= 20)
        await client.shutdown()
    }

    @Test func disabledClientDoesNothing() async throws {
        let transport = MemoryTransport()
        let client = try WardxClient.create(WardxOptions(enabled: false), transport: transport)
        client.counter("c").inc()
        client.event("e")
        client.log.info("m")
        client.timer("t").stop()
        client.retainedCounter("r").inc()
        client.identify("user")
        #expect(client.config.get("key", "fallback") == "fallback")
        client.experiment.goal("g")
        await client.flush()
        await client.shutdown()
        client.stop()
        #expect(transport.jsons.isEmpty)
        #expect(transport.closeCount == 0)
    }

    @Test func misuseIsReportedAndDropped() async throws {
        let reported = MisuseLog()
        let previous = Misuse.replaceHandler { reported.append($0) }
        defer { Misuse.replaceHandler(previous) }
        let transport = MemoryTransport()
        let client = try aligned(testOptions(), transport)
        client.counter("").inc()
        client.retentionActivity("user", channel: "Bad Channel")
        client.counter("ok").add(.nan)
        await client.flush()
        #expect(reported.messages.contains("metric name must be a non-empty string"))
        #expect(reported.messages.contains("retentionActivity channel must match ^[a-z0-9][a-z0-9._-]{0,63}$"))
        #expect(reported.messages.contains("counter.add requires a finite number"))
        #expect(!transport.jsons[0].contains("retention.activity"))
        await client.shutdown()
    }
}

final class MisuseLog: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String] = []

    var messages: [String] { lock.withLock { entries } }

    func append(_ message: String) {
        lock.withLock { entries.append(message) }
    }
}

struct RetainedTests {
    @Test func failedSyncKeepsValuesUntilDelivered() async throws {
        let path = temporaryPath("retained.json")
        let transport = MemoryTransport { index, _ in
            index == 1 ? SyncResult(ok: false, status: 503, text: nil) : MemoryTransport.ok()
        }
        let client = try aligned(testOptions { $0.retainedPath = path }, transport)
        client.retainedCounter("offline.matches", ["mode": "solo"]).add(2)
        await client.flush()
        client.retainedCounter("offline.matches", ["mode": "solo"]).inc()
        await client.flush()
        #expect(transport.jsons.count == 3)
        #expect(transport.jsons[2].contains("[\"offline.matches\",{\"mode\":\"solo\"},3]"))
        await client.flush()
        #expect(!transport.jsons.last!.contains("offline.matches"))
        await client.shutdown()
    }

    @Test func permanentRejectionDropsOnlyTheFlight() async throws {
        let path = temporaryPath("retained.json")
        let transport = MemoryTransport { _, json in
            json.contains("offline.matches") ? SyncResult(ok: false, status: 400, text: nil) : MemoryTransport.ok()
        }
        let client = try aligned(testOptions { $0.retainedPath = path }, transport)
        client.retainedCounter("offline.matches").inc()
        await client.flush()
        let count = transport.jsons.count
        await client.flush()
        #expect(transport.jsons.count == count + 1)
        #expect(!transport.jsons.last!.contains("offline.matches"))
        await client.shutdown()
    }

    @Test func valuesSurviveRestart() async throws {
        let path = temporaryPath("retained.json")
        let first = try aligned(testOptions { $0.retainedPath = path }, MemoryTransport())
        first.retainedCounter("offline.matches").add(4)
        first.retainedDistinct("offline.users").add("user-1")
        first.stop()

        let transport = MemoryTransport()
        let second = try aligned(testOptions { $0.retainedPath = path }, transport)
        await second.flush()
        let sent = transport.jsons.joined()
        #expect(sent.contains("[\"offline.matches\",null,4]"))
        #expect(sent.contains("\"offline.users\""))
        #expect(!sent.contains("user-1"))
        await second.shutdown()

        let third = try aligned(testOptions { $0.retainedPath = path }, MemoryTransport())
        #expect(third.core!.captureRetainedFramesIsEmpty())
        third.stop()
    }

    @Test func corruptFileStartsEmpty() async throws {
        let path = temporaryPath("retained.json")
        try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        try Data("{not json".utf8).write(to: URL(fileURLWithPath: path))
        let transport = MemoryTransport()
        let client = try aligned(testOptions { $0.retainedPath = path }, transport)
        client.retainedCounter("fresh").inc()
        await client.flush()
        #expect(transport.jsons.joined().contains("[\"fresh\",null,1]"))
        await client.shutdown()
    }

    @Test func seriesCapBoundsRetainedState() async throws {
        let transport = MemoryTransport()
        let client = try aligned(testOptions {
            $0.retainedPath = temporaryPath("retained.json")
            $0.maxRetainedSeries = 2
        }, transport)
        for index in 0..<3 { client.retainedCounter("r", ["i": WardxValue(index)]).inc() }
        await client.flush()
        let sent = transport.jsons.joined()
        #expect(sent.contains("[\"wardx.internal.cardinality_dropped\",null,1]"))
        #expect(!sent.contains("{\"i\":2}"))
        await client.shutdown()
    }
}

extension WardxCore {
    func captureRetainedFramesIsEmpty() -> Bool {
        (try? captureRetainedFrames()) == nil
    }
}
