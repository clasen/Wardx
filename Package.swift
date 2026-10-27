// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "Wardx",
    platforms: [.macOS(.v12), .iOS(.v15)],
    products: [
        .library(name: "Wardx", targets: ["Wardx"])
    ],
    targets: [
        .target(name: "Wardx", path: "clients/swift/Sources/Wardx"),
        .executableTarget(name: "WardxInterop", dependencies: ["Wardx"], path: "clients/swift/Sources/WardxInterop"),
        .testTarget(name: "WardxTests", dependencies: ["Wardx"], path: "clients/swift/Tests/WardxTests")
    ]
)
