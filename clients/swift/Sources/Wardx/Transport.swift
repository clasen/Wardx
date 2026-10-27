import Compression
import Foundation

public struct SyncResult: Sendable {
    public let ok: Bool
    public let status: Int
    public let text: String?

    public init(ok: Bool, status: Int, text: String?) {
        self.ok = ok
        self.status = status
        self.text = text
    }
}

/// Posts one gzipped envelope to `POST /v1/sync`.
public protocol SyncTransport: Sendable {
    func post(_ gzippedBody: Data) async throws -> SyncResult
    func close()
}

public final class URLSessionTransport: SyncTransport {
    private let url: URL
    private let projectKey: String
    private let session: URLSession
    private let ownsSession: Bool

    public init(endpoint: String, projectKey: String, httpTimeoutMs: Int, session: URLSession? = nil) throws {
        url = try Self.syncURL(endpoint)
        self.projectKey = projectKey
        if let session {
            self.session = session
            ownsSession = false
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = Double(httpTimeoutMs) / 1000
            self.session = URLSession(configuration: configuration)
            ownsSession = true
        }
    }

    public func post(_ gzippedBody: Data) async throws -> SyncResult {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = gzippedBody
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("gzip", forHTTPHeaderField: "Content-Encoding")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(projectKey, forHTTPHeaderField: "X-Wardx-Key")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw WardxError("sync response is not HTTP") }
        return SyncResult(ok: (200..<300).contains(http.statusCode), status: http.statusCode, text: String(data: data, encoding: .utf8))
    }

    public func close() {
        if ownsSession { session.invalidateAndCancel() }
    }

    static func syncURL(_ endpoint: String) throws -> URL {
        guard let url = URL(string: endpoint), url.scheme != nil, url.host != nil else {
            throw WardxError("endpoint must be an absolute URL")
        }
        if url.path.isEmpty || url.path == "/" {
            return url.appendingPathComponent("v1/sync")
        }
        return url
    }
}

enum Gzip {
    /// RFC 1952 member: header, raw DEFLATE from the Compression framework, CRC-32, and size.
    static func compress(_ input: Data) throws -> Data {
        var output = Data([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff])
        output.append(try deflate(input))
        var crc = crc32(input).littleEndian
        var size = UInt32(truncatingIfNeeded: input.count).littleEndian
        withUnsafeBytes(of: &crc) { output.append(contentsOf: $0) }
        withUnsafeBytes(of: &size) { output.append(contentsOf: $0) }
        return output
    }

    static func decompress(_ input: Data) throws -> Data {
        guard input.count >= 18, input[input.startIndex] == 0x1f, input[input.startIndex + 1] == 0x8b,
              input[input.startIndex + 3] == 0 else {
            throw WardxError("unsupported gzip member")
        }
        let body = input.subdata(in: (input.startIndex + 10)..<(input.endIndex - 8))
        return try process(body, COMPRESSION_STREAM_DECODE)
    }

    private static func deflate(_ input: Data) throws -> Data {
        try process(input, COMPRESSION_STREAM_ENCODE)
    }

    private static func process(_ input: Data, _ operation: compression_stream_operation) throws -> Data {
        let stream = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
        defer { stream.deallocate() }
        guard compression_stream_init(stream, operation, COMPRESSION_ZLIB) == COMPRESSION_STATUS_OK else {
            throw WardxError("compression stream failed to initialize")
        }
        defer { compression_stream_destroy(stream) }
        let chunk = 64 * 1024
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: chunk)
        defer { buffer.deallocate() }
        var output = Data()
        try input.withUnsafeBytes { (source: UnsafeRawBufferPointer) in
            stream.pointee.src_ptr = source.bindMemory(to: UInt8.self).baseAddress ?? UnsafePointer(buffer)
            stream.pointee.src_size = source.count
            while true {
                stream.pointee.dst_ptr = buffer
                stream.pointee.dst_size = chunk
                let status = compression_stream_process(stream, Int32(COMPRESSION_STREAM_FINALIZE.rawValue))
                output.append(buffer, count: chunk - stream.pointee.dst_size)
                switch status {
                case COMPRESSION_STATUS_OK: continue
                case COMPRESSION_STATUS_END: return
                default: throw WardxError("compression stream failed")
                }
            }
        }
        return output
    }

    private static let crcTable: [UInt32] = (0..<256).map { index in
        var value = UInt32(index)
        for _ in 0..<8 { value = value & 1 != 0 ? 0xedb88320 ^ (value >> 1) : value >> 1 }
        return value
    }

    static func crc32(_ data: Data) -> UInt32 {
        var crc: UInt32 = 0xffffffff
        for byte in data { crc = crcTable[Int((crc ^ UInt32(byte)) & 0xff)] ^ (crc >> 8) }
        return crc ^ 0xffffffff
    }
}
