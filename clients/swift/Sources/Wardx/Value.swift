import Foundation

/// A dimension, attribute, or exemplar value: a string, finite number, or boolean.
public enum WardxValue: Sendable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)

    public init(_ value: String) { self = .string(value) }
    public init(_ value: Int) { self = .number(Double(value)) }
    public init(_ value: Double) { self = .number(value) }
    public init(_ value: Bool) { self = .bool(value) }

    var json: JSONValue {
        switch self {
        case .string(let value): return .string(value)
        case .number(let value): return .number(value)
        case .bool(let value): return .bool(value)
        }
    }

    var text: String {
        switch self {
        case .string(let value): return value
        case .number(let value): return JSON.number(value)
        case .bool(let value): return value ? "true" : "false"
        }
    }

    var isFinite: Bool {
        if case .number(let value) = self { return value.isFinite }
        return true
    }
}

extension WardxValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral, ExpressibleByBooleanLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(floatLiteral value: Double) { self = .number(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
}

/// Metric dimensions, or event, log, and exemplar attributes.
public typealias Dims = [String: WardxValue]

/// A JSON value as received in Remote Config or sent on the wire.
public indirect enum JSONValue: Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public subscript(key: String) -> JSONValue? {
        if case .object(let object) = self { return object[key] }
        return nil
    }

    var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    var numberValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    var objectValue: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }

    var arrayValue: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }
}

func jsonObject(_ dims: Dims?) -> [String: JSONValue]? {
    guard let dims, !dims.isEmpty else { return nil }
    return dims.mapValues(\.json)
}

func jsonOrNull(_ object: [String: JSONValue]?) -> JSONValue {
    guard let object, !object.isEmpty else { return .null }
    return .object(object)
}

enum JSON {
    /// Serializes with sorted object keys so equal values produce equal bytes.
    static func stringify(_ value: JSONValue) -> String {
        var out = ""
        write(value, into: &out)
        return out
    }

    static func byteCount(_ value: JSONValue) -> Int {
        stringify(value).utf8.count
    }

    static func number(_ value: Double) -> String {
        precondition(value.isFinite, "JSON numbers must be finite")
        if value == value.rounded(.towardZero), abs(value) < 9.2e18 {
            return String(Int64(value))
        }
        return "\(value)"
    }

    static func parse(_ text: String) throws -> JSONValue {
        try parse(Data(text.utf8))
    }

    static func parse(_ data: Data) throws -> JSONValue {
        convert(try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]))
    }

    private static func convert(_ object: Any) -> JSONValue {
        switch object {
        case is NSNull:
            return .null
        case let number as NSNumber:
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return .bool(number.boolValue) }
            return .number(number.doubleValue)
        case let string as String:
            return .string(string)
        case let array as [Any]:
            return .array(array.map(convert))
        case let dictionary as [String: Any]:
            return .object(dictionary.mapValues(convert))
        default:
            preconditionFailure("JSONSerialization returned \(type(of: object))")
        }
    }

    private static func write(_ value: JSONValue, into out: inout String) {
        switch value {
        case .null:
            out += "null"
        case .bool(let bool):
            out += bool ? "true" : "false"
        case .number(let number):
            out += self.number(number)
        case .string(let string):
            writeString(string, into: &out)
        case .array(let array):
            out += "["
            for (index, item) in array.enumerated() {
                if index > 0 { out += "," }
                write(item, into: &out)
            }
            out += "]"
        case .object(let object):
            out += "{"
            for (index, key) in object.keys.sorted().enumerated() {
                if index > 0 { out += "," }
                writeString(key, into: &out)
                out += ":"
                write(object[key]!, into: &out)
            }
            out += "}"
        }
    }

    private static func writeString(_ string: String, into out: inout String) {
        out += "\""
        for scalar in string.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
    }
}

/// A type `Config.get` can read from a Remote Config value.
public protocol ConfigValue {
    init?(configValue: JSONValue)
}

extension String: ConfigValue {
    public init?(configValue: JSONValue) {
        guard case .string(let value) = configValue else { return nil }
        self = value
    }
}

extension Bool: ConfigValue {
    public init?(configValue: JSONValue) {
        guard case .bool(let value) = configValue else { return nil }
        self = value
    }
}

extension Double: ConfigValue {
    public init?(configValue: JSONValue) {
        guard case .number(let value) = configValue else { return nil }
        self = value
    }
}

extension Int: ConfigValue {
    public init?(configValue: JSONValue) {
        guard case .number(let value) = configValue, let exact = Int(exactly: value) else { return nil }
        self = exact
    }
}

extension JSONValue: ConfigValue {
    public init?(configValue: JSONValue) {
        self = configValue
    }
}
