import Foundation
import Wardx

/// Drives a real client against a wardx-server CLI for packages/server/test/swift-interop.mjs.
func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func expect<T: Equatable>(_ expected: T, _ actual: T, _ message: String) {
    if expected != actual { fail("\(message): expected <\(expected)> got <\(actual)>") }
}

let arguments = CommandLine.arguments
guard arguments.count == 2 else { fail("usage: WardxInterop <endpoint>") }

var options = WardxOptions(
    endpoint: arguments[1],
    projectKey: "black-box-key",
    project: "demo",
    role: "swift",
    appVersion: "1.0.0",
    environment: "test",
    privacySalt: "black-box-privacy-salt"
)
options.attributes = ["tier": 1]
options.aggregateIntervalMs = 60_000
options.syncIntervalMs = 60_000
options.httpTimeoutMs = 2_000
options.retainedPath = FileManager.default.temporaryDirectory
    .appendingPathComponent("wardx-swift-interop-\(UUID().uuidString).json").path

let client: WardxClient
do {
    client = try WardxClient.create(options)
} catch {
    fail("create failed: \(error)")
}

var remote = "missing"
for _ in 0..<200 {
    remote = client.config.get("interop.remote", "missing", subjectId: "interop-subject")
    if remote == "experiment" { break }
    try? await Task.sleep(nanoseconds: 25_000_000)
}
expect("experiment", remote, "interop.remote for the experiment subject")
expect("conditional", client.config.get("interop.remote", "missing"), "conditional base from Node server")
client.setAttributes(["tier": 3])
await client.flush()
expect("base", client.config.get("interop.remote", "missing"), "attribute change refreshes base")
expect("experiment", client.config.get("interop.remote", "missing", subjectId: "interop-subject"), "experiment still overrides base")
expect("hidden", client.config.get("interop.hidden", "hidden", subjectId: "interop-subject"), "interop.hidden must remain role-filtered")

client.counter("interop.counter", ["runtime": "swift"]).inc()
client.retainedCounter("interop.retained", ["runtime": "swift"]).add(3)
client.retentionActivity("interop-subject", channel: "interop-channel")
client.conversion("interop-subject", goal: "purchase")
let hids = client.distinct("interop.hids", ["result": "violating"])
hids.add("interop-private-hid")
hids.add("interop-private-hid")
client.event("interop.event", ["runtime": "swift"])
client.experiment.goal("interop.goal", subjectId: "interop-subject", value: 2)
await client.shutdown()
try? FileManager.default.removeItem(atPath: options.retainedPath!)
print("{\"ok\":true,\"remote\":\"experiment\"}")
