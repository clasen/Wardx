struct VariantDefinition {
    var key: String
    var weight: Double
    var values: [String: JSONValue]
}

struct ExperimentDefinition {
    var id: String
    var enabled: Bool
    var allocation: Double
    var salt: String
    var goalMetric: String?
    var primaryMetric: String?
    var variants: [VariantDefinition]

    /// Parses the wire snapshot; missing fields default like the C# SDK.
    init(wire: [String: JSONValue]) {
        id = wire["id"]?.stringValue ?? ""
        if case .bool(let value)? = wire["enabled"] { enabled = value } else { enabled = false }
        allocation = wire["allocation"]?.numberValue ?? 0
        salt = wire["salt"]?.stringValue ?? ""
        goalMetric = wire["goalMetric"]?.stringValue
        primaryMetric = wire["primaryMetric"]?.stringValue
        variants = (wire["variants"]?.arrayValue ?? []).compactMap(\.objectValue).map {
            VariantDefinition(
                key: $0["key"]?.stringValue ?? "",
                weight: $0["weight"]?.numberValue ?? 0,
                values: $0["values"]?.objectValue ?? [:]
            )
        }
    }

    init(id: String, enabled: Bool, allocation: Double, salt: String, goalMetric: String?, primaryMetric: String? = nil, variants: [VariantDefinition]) {
        self.id = id
        self.enabled = enabled
        self.allocation = allocation
        self.salt = salt
        self.goalMetric = goalMetric
        self.primaryMetric = primaryMetric
        self.variants = variants
    }

    /// Identifies the definition so a changed experiment resets local assignment state.
    var fingerprint: String {
        let variants: [JSONValue] = variants.map {
            .object(["key": .string($0.key), "values": .object($0.values), "weight": .number($0.weight)])
        }
        let canonical: JSONValue = .object([
            "allocation": .number(allocation),
            "enabled": .bool(enabled),
            "goalMetric": goalMetric.map(JSONValue.string) ?? .null,
            "id": .string(id),
            "primaryMetric": primaryMetric.map(JSONValue.string) ?? .null,
            "salt": .string(salt),
            "variants": .array(variants)
        ])
        return Hash.subjectHash(salt: "wardx.experiment.snapshot", subjectId: JSON.stringify(canonical))
    }
}

enum Experiments {
    static func assignVariant(_ experiment: ExperimentDefinition, subjectId: String) throws -> VariantDefinition? {
        guard experiment.enabled else { return nil }
        let bucket = Hash.hashToUnitInterval(
            Hash.assignmentHash(experimentId: experiment.id, subjectId: subjectId, salt: experiment.salt)
        )
        if bucket >= experiment.allocation { return nil }
        let variants = experiment.variants
        if variants.isEmpty { throw WardxError("experiment \(experiment.id) has no variants") }
        var totalWeight = 0.0
        for variant in variants {
            if !variant.weight.isFinite || variant.weight < 0 {
                throw WardxError("experiment \(experiment.id) has invalid variant weight")
            }
            totalWeight += variant.weight
        }
        if totalWeight <= 0 { throw WardxError("experiment \(experiment.id) variant weights must sum to > 0") }
        var threshold = 0.0
        for variant in variants {
            threshold += (variant.weight / totalWeight) * experiment.allocation
            if bucket < threshold { return variant }
        }
        return variants[variants.count - 1]
    }

    static func indexByKey(_ experiments: [ExperimentDefinition]) -> [String: [ExperimentDefinition]] {
        var map: [String: [ExperimentDefinition]] = [:]
        for experiment in experiments where experiment.enabled {
            for variant in experiment.variants {
                for key in variant.values.keys where !(map[key]?.contains { $0.id == experiment.id } ?? false) {
                    map[key, default: []].append(experiment)
                }
            }
        }
        return map
    }
}

final class ExperimentAssignment {
    let experiment: String
    let variant: String
    let goalMetric: String?
    let fingerprint: String
    var exposed = false

    init(experiment: String, variant: String, goalMetric: String?, fingerprint: String) {
        self.experiment = experiment
        self.variant = variant
        self.goalMetric = goalMetric
        self.fingerprint = fingerprint
    }
}

/// Assignment and exposure state per hashed subject, bounded by `stateMaxSubjects` with the
/// oldest subject evicted first.
final class ExperimentResolver {
    private let privacySalt: String
    private let stateMaxSubjects: Int
    private let onExposure: ([String: JSONValue]) -> Void
    private var stateBySubject: [String: (order: Int, assignments: [String: ExperimentAssignment])] = [:]
    private var order: [(subject: String, order: Int)] = []
    private var orderHead = 0
    private var nextOrder = 0

    init(privacySalt: String, stateMaxSubjects: Int, onExposure: @escaping ([String: JSONValue]) -> Void) {
        self.privacySalt = privacySalt
        self.stateMaxSubjects = stateMaxSubjects
        self.onExposure = onExposure
    }

    var stateCount: Int { stateBySubject.count }

    func hashSubject(_ subjectId: String) -> String {
        Hash.subjectHash(salt: privacySalt, subjectId: subjectId)
    }

    func recordAssignment(subjectId: String, experiment: ExperimentDefinition, variant: VariantDefinition) -> ExperimentAssignment {
        let subject = hashSubject(subjectId)
        if stateBySubject[subject] == nil {
            while stateBySubject.count >= stateMaxSubjects { evictOldest() }
            stateBySubject[subject] = (nextOrder, [:])
            order.append((subject, nextOrder))
            nextOrder += 1
        }
        if let known = stateBySubject[subject]!.assignments[experiment.id] { return known }
        let assignment = ExperimentAssignment(
            experiment: experiment.id,
            variant: variant.key,
            goalMetric: experiment.goalMetric,
            fingerprint: experiment.fingerprint
        )
        stateBySubject[subject]!.assignments[experiment.id] = assignment
        return assignment
    }

    func assignments(for subjectId: String) -> [ExperimentAssignment] {
        stateBySubject[hashSubject(subjectId)].map { Array($0.assignments.values) } ?? []
    }

    func resolve(key: String, remote: JSONValue, subjectId: String?, byKey: [String: [ExperimentDefinition]]) throws -> JSONValue {
        guard let subjectId, let list = byKey[key] else { return remote }
        for experiment in list {
            guard let variant = try Experiments.assignVariant(experiment, subjectId: subjectId),
                  let value = variant.values[key] else { continue }
            let assignment = recordAssignment(subjectId: subjectId, experiment: experiment, variant: variant)
            expose(assignment, subjectId: subjectId)
            return value
        }
        return remote
    }

    func exposedAssignment(subjectId: String, goalMetric: String) throws -> ExperimentAssignment? {
        var match: ExperimentAssignment?
        for assignment in assignments(for: subjectId) where assignment.exposed && assignment.goalMetric == goalMetric {
            if match != nil { throw WardxError("goal metric \(goalMetric) matches multiple exposed experiments") }
            match = assignment
        }
        return match
    }

    func applySnapshot(_ experiments: [ExperimentDefinition]) {
        var active: [String: String] = [:]
        for experiment in experiments where experiment.enabled { active[experiment.id] = experiment.fingerprint }
        for (subject, state) in stateBySubject {
            let kept = state.assignments.filter { active[$0.key] == $0.value.fingerprint }
            stateBySubject[subject] = kept.isEmpty ? nil : (state.order, kept)
        }
        order = order[orderHead...].filter { stateBySubject[$0.subject]?.order == $0.order }
        orderHead = 0
    }

    private func expose(_ assignment: ExperimentAssignment, subjectId: String) {
        if assignment.exposed { return }
        assignment.exposed = true
        onExposure([
            "experiment": .string(assignment.experiment),
            "variant": .string(assignment.variant),
            "subject": .string(hashSubject(subjectId))
        ])
    }

    /// Skips queue entries whose subject was removed or re-added since they were queued.
    private func evictOldest() {
        while orderHead < order.count {
            let entry = order[orderHead]
            orderHead += 1
            if stateBySubject[entry.subject]?.order == entry.order {
                stateBySubject[entry.subject] = nil
                break
            }
        }
        if orderHead > 1024, orderHead * 2 > order.count {
            order.removeFirst(orderHead)
            orderHead = 0
        }
    }
}

final class ConfigStore {
    private(set) var version = 0
    private(set) var values: [String: JSONValue] = [:]
    private(set) var experiments: [ExperimentDefinition] = []
    private(set) var experimentsByKey: [String: [ExperimentDefinition]] = [:]

    func applySnapshot(version: Int, values: [String: JSONValue], experiments: [ExperimentDefinition]) throws {
        for experiment in experiments where experiment.goalMetric?.isEmpty ?? true {
            throw WardxError("experiment \(experiment.id) requires a non-empty goalMetric")
        }
        self.version = version
        self.values = values
        self.experiments = experiments
        experimentsByKey = Experiments.indexByKey(experiments)
    }
}
