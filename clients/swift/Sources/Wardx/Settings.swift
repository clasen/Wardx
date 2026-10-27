import Foundation

/// Operational defaults. Same values as packages/core/defaults.json.
public enum SdkDefaults {
    public static let aggregateIntervalMs = 1000
    public static let syncIntervalMs = 15000
    public static let syncJitterMin = 0.85
    public static let syncJitterMax = 1.15
    public static let maxBufferedEvents = 5000
    public static let maxBufferedLogs = 2000
    public static let maxFrameBytes = 524288
    public static let maxPendingFrames = 32
    public static let maxEnvelopeItems = 10000
    public static let maxEnvelopeBytes = 2097152
    public static let maxSeriesPerMetric = 1000
    public static let maxDimensionKeys = 8
    public static let maxDimensionValueLength = 64
    public static let experimentStateMaxSubjects = 100000
    public static let httpTimeoutMs = 10000
    public static let histogramBuckets: [Double] = [10, 25, 50, 100, 250, 500, 1000]

    // Swift and C# only: retained metrics have no Node counterpart.
    public static let maxRetainedSeries = 64

    public static let version = "0.1.0"
}

public struct WardxError: Error, CustomStringConvertible, Equatable {
    public let message: String

    init(_ message: String) {
        self.message = message
    }

    public var description: String { message }
}

enum Clock {
    static func unixMs() -> Int64 {
        Int64((Date().timeIntervalSince1970 * 1000).rounded(.down))
    }

    static func monotonicMs() -> Double {
        Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000
    }
}

enum WireProtocol {
    static let version = 1

    enum Internal {
        static let eventsBuffered = "wardx.internal.events_buffered"
        static let logsBuffered = "wardx.internal.logs_buffered"
        static let eventsDropped = "wardx.internal.events_dropped"
        static let logsDropped = "wardx.internal.logs_dropped"
        static let cardinalityDropped = "wardx.internal.cardinality_dropped"
        static let framesSent = "wardx.internal.frames_sent"
        static let framesFailed = "wardx.internal.frames_failed"
        static let bytesUncompressed = "wardx.internal.bytes_uncompressed"
        static let bytesCompressed = "wardx.internal.bytes_compressed"
        static let lastSyncMs = "wardx.internal.last_sync_ms"
        static let configVersion = "wardx.internal.config_version"
        static let processRssBytes = "wardx.internal.process_rss_bytes"
        static let frameRowsDropped = "wardx.internal.frame_rows_dropped"
    }
}

public struct WardxOptions: Sendable {
    public var enabled = true
    public var endpoint: String?
    public var projectKey: String?
    public var project: String?
    public var role: String?
    public var appVersion: String?
    public var environment: String?
    public var attributes: Dims?
    public var privacySalt: String?
    public var tracer: (any WardxTracer)?
    public var aggregateIntervalMs: Int?
    public var syncIntervalMs: Int?
    public var syncJitterMin: Double?
    public var syncJitterMax: Double?
    public var maxBufferedEvents: Int?
    public var maxBufferedLogs: Int?
    public var maxFrameBytes: Int?
    public var maxPendingFrames: Int?
    public var maxEnvelopeItems: Int?
    public var maxEnvelopeBytes: Int?
    public var maxSeriesPerMetric: Int?
    public var maxDimensionKeys: Int?
    public var maxDimensionValueLength: Int?
    public var experimentStateMaxSubjects: Int?
    public var httpTimeoutMs: Int?
    public var histogramBuckets: [Double]?
    public var retainedPath: String?
    public var maxRetainedSeries: Int?

    public init(
        enabled: Bool = true,
        endpoint: String? = nil,
        projectKey: String? = nil,
        project: String? = nil,
        role: String? = nil,
        appVersion: String? = nil,
        environment: String? = nil,
        privacySalt: String? = nil
    ) {
        self.enabled = enabled
        self.endpoint = endpoint
        self.projectKey = projectKey
        self.project = project
        self.role = role
        self.appVersion = appVersion
        self.environment = environment
        self.privacySalt = privacySalt
    }
}

struct Settings: Sendable {
    var enabled = true
    var endpoint = ""
    var projectKey = ""
    var project = ""
    var role = ""
    var appVersion = ""
    var environment = ""
    var attributes: Dims?
    var privacySalt = ""
    var tracer: (any WardxTracer)?
    var aggregateIntervalMs = SdkDefaults.aggregateIntervalMs
    var syncIntervalMs = SdkDefaults.syncIntervalMs
    var syncJitterMin = SdkDefaults.syncJitterMin
    var syncJitterMax = SdkDefaults.syncJitterMax
    var maxBufferedEvents = SdkDefaults.maxBufferedEvents
    var maxBufferedLogs = SdkDefaults.maxBufferedLogs
    var maxFrameBytes = SdkDefaults.maxFrameBytes
    var maxPendingFrames = SdkDefaults.maxPendingFrames
    var maxEnvelopeItems = SdkDefaults.maxEnvelopeItems
    var maxEnvelopeBytes = SdkDefaults.maxEnvelopeBytes
    var maxSeriesPerMetric = SdkDefaults.maxSeriesPerMetric
    var maxDimensionKeys = SdkDefaults.maxDimensionKeys
    var maxDimensionValueLength = SdkDefaults.maxDimensionValueLength
    var experimentStateMaxSubjects = SdkDefaults.experimentStateMaxSubjects
    var httpTimeoutMs = SdkDefaults.httpTimeoutMs
    var histogramBuckets = SdkDefaults.histogramBuckets
    var retainedPath: String?
    var maxRetainedSeries = SdkDefaults.maxRetainedSeries

    static func resolve(_ options: WardxOptions) throws -> Settings {
        guard options.enabled else { return Settings(enabled: false) }
        let required: [(String?, String)] = [
            (options.endpoint, "endpoint"),
            (options.projectKey, "projectKey"),
            (options.project, "project"),
            (options.role, "role"),
            (options.appVersion, "appVersion"),
            (options.environment, "environment"),
            (options.privacySalt, "privacySalt")
        ]
        let missing = required.filter { $0.0 == nil }.map(\.1)
        if !missing.isEmpty {
            throw WardxError("createWardx missing required keys: " + missing.joined(separator: ", "))
        }
        guard let role = options.role, !role.isEmpty else { throw WardxError("role must be a non-empty string") }
        if role == "*" { throw WardxError("role cannot be *") }

        var settings = Settings()
        settings.endpoint = options.endpoint!
        settings.projectKey = options.projectKey!
        settings.project = options.project!
        settings.role = role
        settings.appVersion = options.appVersion!
        settings.environment = options.environment!
        settings.attributes = options.attributes
        settings.privacySalt = options.privacySalt!
        settings.tracer = options.tracer
        settings.aggregateIntervalMs = options.aggregateIntervalMs ?? settings.aggregateIntervalMs
        settings.syncIntervalMs = options.syncIntervalMs ?? settings.syncIntervalMs
        settings.syncJitterMin = options.syncJitterMin ?? settings.syncJitterMin
        settings.syncJitterMax = options.syncJitterMax ?? settings.syncJitterMax
        settings.maxBufferedEvents = options.maxBufferedEvents ?? settings.maxBufferedEvents
        settings.maxBufferedLogs = options.maxBufferedLogs ?? settings.maxBufferedLogs
        settings.maxFrameBytes = options.maxFrameBytes ?? settings.maxFrameBytes
        settings.maxPendingFrames = options.maxPendingFrames ?? settings.maxPendingFrames
        settings.maxEnvelopeItems = options.maxEnvelopeItems ?? settings.maxEnvelopeItems
        settings.maxEnvelopeBytes = options.maxEnvelopeBytes ?? settings.maxEnvelopeBytes
        settings.maxSeriesPerMetric = options.maxSeriesPerMetric ?? settings.maxSeriesPerMetric
        settings.maxDimensionKeys = options.maxDimensionKeys ?? settings.maxDimensionKeys
        settings.maxDimensionValueLength = options.maxDimensionValueLength ?? settings.maxDimensionValueLength
        settings.experimentStateMaxSubjects = options.experimentStateMaxSubjects ?? settings.experimentStateMaxSubjects
        settings.httpTimeoutMs = options.httpTimeoutMs ?? settings.httpTimeoutMs
        settings.histogramBuckets = options.histogramBuckets ?? settings.histogramBuckets
        settings.retainedPath = options.retainedPath
        settings.maxRetainedSeries = options.maxRetainedSeries ?? settings.maxRetainedSeries

        if settings.privacySalt.isEmpty { throw WardxError("privacySalt must be a non-empty string") }
        if settings.retainedPath?.isEmpty == true { throw WardxError("retainedPath must be a non-empty string") }
        try assertPositive(settings.aggregateIntervalMs, "aggregateIntervalMs")
        try assertPositive(settings.syncIntervalMs, "syncIntervalMs")
        try assertPositive(settings.maxBufferedEvents, "maxBufferedEvents")
        try assertPositive(settings.maxBufferedLogs, "maxBufferedLogs")
        try assertPositive(settings.maxFrameBytes, "maxFrameBytes")
        try assertPositive(settings.maxPendingFrames, "maxPendingFrames")
        if settings.maxFrameBytes < 1024 { throw WardxError("maxFrameBytes must be at least 1024") }
        try assertPositive(settings.maxEnvelopeItems, "maxEnvelopeItems")
        try assertPositive(settings.maxEnvelopeBytes, "maxEnvelopeBytes")
        if settings.maxFrameBytes >= settings.maxEnvelopeBytes {
            throw WardxError("maxFrameBytes must be less than maxEnvelopeBytes")
        }
        try assertPositive(settings.maxSeriesPerMetric, "maxSeriesPerMetric")
        try assertPositive(settings.maxDimensionKeys, "maxDimensionKeys")
        try assertPositive(settings.maxDimensionValueLength, "maxDimensionValueLength")
        try assertPositive(settings.experimentStateMaxSubjects, "experimentStateMaxSubjects")
        try assertPositive(settings.httpTimeoutMs, "httpTimeoutMs")
        try assertPositive(settings.maxRetainedSeries, "maxRetainedSeries")
        try assertRange(settings.syncJitterMin, 0, 1, "syncJitterMin")
        try assertRange(settings.syncJitterMax, 1, 2, "syncJitterMax")
        if settings.syncJitterMin > settings.syncJitterMax {
            throw WardxError("syncJitterMin must be <= syncJitterMax")
        }
        try assertBuckets(settings.histogramBuckets, "histogramBuckets")
        return settings
    }

    func nextSyncDelayMs() -> Int {
        let factor = Double.random(in: syncJitterMin...syncJitterMax)
        return Int((Double(syncIntervalMs) * factor).rounded())
    }

    private static func assertPositive(_ value: Int, _ key: String) throws {
        if value <= 0 { throw WardxError(key + " must be a finite number > 0") }
    }

    private static func assertRange(_ value: Double, _ min: Double, _ max: Double, _ key: String) throws {
        if !value.isFinite || value < min || value > max {
            throw WardxError("\(key) must be a finite number in [\(JSON.number(min)), \(JSON.number(max))]")
        }
    }
}

func assertBuckets(_ buckets: [Double], _ label: String) throws {
    if buckets.isEmpty { throw WardxError(label + " must be a non-empty array") }
    var previous = -Double.infinity
    for bound in buckets {
        if !bound.isFinite || bound <= previous {
            throw WardxError(label + " must be strictly increasing finite numbers")
        }
        previous = bound
    }
}
