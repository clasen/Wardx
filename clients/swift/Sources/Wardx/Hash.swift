enum Hash {
    static let fnvOffset32: UInt32 = 0x811c9dc5
    static let fnvPrime32: UInt32 = 0x01000193
    static let uint32: Double = 4294967296.0

    static func fnv1a32(_ input: String) -> UInt32 {
        var hash = fnvOffset32
        for byte in input.utf8 {
            hash ^= UInt32(byte)
            hash = hash &* fnvPrime32
        }
        return hash
    }

    static func hashToUnitInterval(_ hash: UInt32) -> Double {
        Double(hash) / uint32
    }

    static func assignmentHash(experimentId: String, subjectId: String, salt: String) -> UInt32 {
        fnv1a32(experimentId + ":" + subjectId + ":" + salt)
    }

    static func subjectHash(salt: String, subjectId: String) -> String {
        hex(subjectHash64(salt: salt, subjectId: subjectId))
    }

    static func subjectHash64(salt: String, subjectId: String) -> UInt64 {
        xxHash64(Array((salt + "\0" + subjectId).utf8))
    }

    static func hex(_ value: UInt64) -> String {
        let digits = String(value, radix: 16)
        return String(repeating: "0", count: 16 - digits.count) + digits
    }

    private static let prime1: UInt64 = 11400714785074694791
    private static let prime2: UInt64 = 14029467366897019727
    private static let prime3: UInt64 = 1609587929392839161
    private static let prime4: UInt64 = 9650029242287828579
    private static let prime5: UInt64 = 2870177450012600261

    private static func rotateLeft(_ value: UInt64, _ count: UInt64) -> UInt64 {
        (value << count) | (value >> (64 - count))
    }

    private static func round(_ accumulator: UInt64, _ lane: UInt64) -> UInt64 {
        rotateLeft(accumulator &+ lane &* prime2, 31) &* prime1
    }

    private static func mergeRound(_ accumulator: UInt64, _ lane: UInt64) -> UInt64 {
        (accumulator ^ round(0, lane)) &* prime1 &+ prime4
    }

    private static func read64(_ bytes: [UInt8], _ offset: Int) -> UInt64 {
        var value: UInt64 = 0
        for index in 0..<8 { value |= UInt64(bytes[offset + index]) << (8 * UInt64(index)) }
        return value
    }

    private static func read32(_ bytes: [UInt8], _ offset: Int) -> UInt64 {
        var value: UInt64 = 0
        for index in 0..<4 { value |= UInt64(bytes[offset + index]) << (8 * UInt64(index)) }
        return value
    }

    static func xxHash64(_ bytes: [UInt8]) -> UInt64 {
        var offset = 0
        var hash: UInt64
        if bytes.count >= 32 {
            var v1 = prime1 &+ prime2
            var v2 = prime2
            var v3: UInt64 = 0
            var v4: UInt64 = 0 &- prime1
            repeat {
                v1 = round(v1, read64(bytes, offset))
                v2 = round(v2, read64(bytes, offset + 8))
                v3 = round(v3, read64(bytes, offset + 16))
                v4 = round(v4, read64(bytes, offset + 24))
                offset += 32
            } while offset <= bytes.count - 32
            hash = rotateLeft(v1, 1) &+ rotateLeft(v2, 7) &+ rotateLeft(v3, 12) &+ rotateLeft(v4, 18)
            hash = mergeRound(hash, v1)
            hash = mergeRound(hash, v2)
            hash = mergeRound(hash, v3)
            hash = mergeRound(hash, v4)
        } else {
            hash = prime5
        }
        hash = hash &+ UInt64(bytes.count)
        while offset <= bytes.count - 8 {
            hash ^= round(0, read64(bytes, offset))
            hash = rotateLeft(hash, 27) &* prime1 &+ prime4
            offset += 8
        }
        if offset <= bytes.count - 4 {
            hash ^= read32(bytes, offset) &* prime1
            hash = rotateLeft(hash, 23) &* prime2 &+ prime3
            offset += 4
        }
        while offset < bytes.count {
            hash ^= UInt64(bytes[offset]) &* prime5
            hash = rotateLeft(hash, 11) &* prime1
            offset += 1
        }
        hash ^= hash >> 33
        hash = hash &* prime2
        hash ^= hash >> 29
        hash = hash &* prime3
        return hash ^ (hash >> 32)
    }
}

enum Ids {
    private static let encoding = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    static func ulid(now: Int64 = Clock.unixMs()) -> String {
        var chars = [Character](repeating: "0", count: 26)
        var time = now
        for index in stride(from: 9, through: 0, by: -1) {
            chars[index] = encoding[Int(time & 31)]
            time /= 32
        }
        var generator = SystemRandomNumberGenerator()
        var bits: UInt128Pair = (generator.next(), generator.next())
        for index in 10..<26 {
            chars[index] = encoding[Int(bits.0 & 31)]
            bits.0 = (bits.0 >> 5) | (bits.1 << 59)
            bits.1 >>= 5
        }
        return String(chars)
    }

    private typealias UInt128Pair = (UInt64, UInt64)
}
