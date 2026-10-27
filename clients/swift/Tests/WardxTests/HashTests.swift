import Foundation
import Testing
@testable import Wardx

struct HashTests {
    @Test func fnvMatchesKnownVectors() {
        #expect(Hash.fnv1a32("") == 0x811c9dc5)
        #expect(Hash.fnv1a32("a") == 0xe40c292c)
        #expect(Hash.fnv1a32("foobar") == 0xbf9cf968)
        #expect(Hash.fnv1a32("costarring") == Hash.fnv1a32("liquid"))
        let latin1 = (Hash.fnvOffset32 ^ 0xe9) &* Hash.fnvPrime32
        #expect(Hash.fnv1a32("é") != latin1)
    }

    @Test func xxHashSeparatesFnvCollisions() {
        let first = Hash.subjectHash(salt: "test-salt", subjectId: "costarring")
        #expect(first.count == 16)
        #expect(first != Hash.subjectHash(salt: "test-salt", subjectId: "liquid"))
    }

    @Test func sharedFixtureMatchesNodeAndCSharp() throws {
        let url = repositoryRoot.appendingPathComponent("packages/core/test/fixtures/xxhash64.json")
        let fixture = try JSON.parse(Data(contentsOf: url))
        for vector in fixture["raw"]?.arrayValue ?? [] {
            let bytes = [UInt8](Data(base64Encoded: vector["input"]!.stringValue!)!)
            #expect(Hash.hex(Hash.xxHash64(bytes)) == vector["hash"]?.stringValue)
        }
        let subjects = fixture["subjects"]?.arrayValue ?? []
        #expect(!subjects.isEmpty)
        for vector in subjects {
            let salt = vector["salt"]!.stringValue!
            let subject = vector["subject"]!.stringValue!
            #expect(Hash.subjectHash(salt: salt, subjectId: subject) == vector["hash"]?.stringValue)
            if salt.isEmpty || subject.isEmpty { continue }
            let hll = HyperLogLog(name: "users", dims: nil, privacySalt: salt)
            hll.add(subject)
            hll.add(subject)
            let registers = [UInt8](Data(base64Encoded: hll.snapshot().registers)!)
            let index = Int(vector["index"]!.numberValue!)
            let rank = UInt8(vector["rank"]!.numberValue!)
            for (position, register) in registers.enumerated() {
                #expect(register == (position == index ? rank : 0))
            }
        }
    }

    @Test func ulidIsSortableAndUnique() {
        let first = Ids.ulid(now: 1_700_000_000_000)
        let second = Ids.ulid(now: 1_700_000_000_001)
        #expect(first.count == 26)
        #expect(first < second)
        #expect(Ids.ulid() != Ids.ulid())
    }
}

struct JSONTests {
    @Test func numbersUseIntegersWhenExact() throws {
        #expect(JSON.stringify(.number(1)) == "1")
        #expect(JSON.stringify(.number(-0.0)) == "0")
        #expect(JSON.stringify(.number(1.5)) == "1.5")
        #expect(JSON.stringify(.number(1_787_221_135_102)) == "1787221135102")
        #expect(try JSON.parse(JSON.stringify(.number(0.1))) == .number(0.1))
        #expect(try JSON.parse(JSON.stringify(.number(1e-7))) == .number(1e-7))
    }

    @Test func stringsEscapeControlCharacters() throws {
        let text = "q\"b\\n\n\t\u{01}é😀"
        #expect(JSON.stringify(.string(text)) == "\"q\\\"b\\\\n\\n\\t\\u0001é😀\"")
        #expect(try JSON.parse(JSON.stringify(.string(text))) == .string(text))
    }

    @Test func parseKeepsBooleansApartFromNumbers() throws {
        let value = try JSON.parse("{\"a\":true,\"b\":1,\"c\":0,\"d\":null,\"e\":[false]}")
        #expect(value == .object(["a": .bool(true), "b": .number(1), "c": .number(0), "d": .null, "e": .array([.bool(false)])]))
    }

    @Test func objectsSerializeWithSortedKeys() {
        #expect(JSON.stringify(.object(["b": .number(1), "a": .null])) == "{\"a\":null,\"b\":1}")
    }

    @Test func gzipIsReadableBySystemGzip() throws {
        let input = Data(String(repeating: "wardx telemetry ", count: 5000).utf8)
        let compressed = try Gzip.compress(input)
        #expect(compressed.count < input.count)
        #expect(try Gzip.decompress(compressed) == input)
        #expect(try Gzip.decompress(Gzip.compress(Data())) == Data())

        let path = temporaryPath("body.gz")
        try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        try compressed.write(to: URL(fileURLWithPath: path))
        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/gzip")
        process.arguments = ["-dc", path]
        process.standardOutput = output
        try process.run()
        let decoded = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        #expect(process.terminationStatus == 0)
        #expect(decoded == input)
    }
}
