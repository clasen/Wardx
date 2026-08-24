using System;
using System.Collections.Generic;

namespace Wardx
{
    public sealed class VariantDefinition
    {
        public string Key;
        public double Weight;
        public Dictionary<string, object> Values;
    }

    public sealed class ExperimentDefinition
    {
        public string Id;
        public bool Enabled;
        public double Allocation;
        public string Salt;
        public string GoalMetric;
        public string PrimaryMetric;
        public List<VariantDefinition> Variants;
    }

    public static class Experiments
    {
        public static VariantDefinition AssignVariant(ExperimentDefinition experiment, string subjectId)
        {
            if (!experiment.Enabled) return null;
            var hash = Hash.AssignmentHash(experiment.Id, subjectId, experiment.Salt);
            var bucket = Hash.HashToUnitInterval(hash);
            if (bucket >= experiment.Allocation) return null;
            var variants = experiment.Variants;
            if (variants == null || variants.Count == 0)
            {
                throw new InvalidOperationException("experiment " + experiment.Id + " has no variants");
            }
            double totalWeight = 0;
            for (int i = 0; i < variants.Count; i++)
            {
                var weight = variants[i].Weight;
                if (double.IsNaN(weight) || double.IsInfinity(weight) || weight < 0)
                {
                    throw new InvalidOperationException("experiment " + experiment.Id + " has invalid variant weight");
                }
                totalWeight += weight;
            }
            if (totalWeight <= 0)
            {
                throw new InvalidOperationException("experiment " + experiment.Id + " variant weights must sum to > 0");
            }
            double threshold = 0;
            for (int i = 0; i < variants.Count; i++)
            {
                threshold += (variants[i].Weight / totalWeight) * experiment.Allocation;
                if (bucket < threshold) return variants[i];
            }
            return variants[variants.Count - 1];
        }

        public static Dictionary<string, List<ExperimentDefinition>> IndexByKey(IReadOnlyList<ExperimentDefinition> experiments)
        {
            var map = new Dictionary<string, List<ExperimentDefinition>>();
            if (experiments == null) return map;
            foreach (var experiment in experiments)
            {
                if (!experiment.Enabled) continue;
                foreach (var variant in experiment.Variants)
                {
                    foreach (var key in variant.Values.Keys)
                    {
                        if (!map.TryGetValue(key, out var list))
                        {
                            list = new List<ExperimentDefinition>();
                            map[key] = list;
                        }
                        if (!list.Contains(experiment)) list.Add(experiment);
                    }
                }
            }
            return map;
        }
    }

    public sealed class ExperimentAssignment
    {
        public string Experiment;
        public string Variant;
        internal string GoalMetric;
        internal string Fingerprint;
        internal bool Exposed;
    }

    sealed class ExperimentSubjectState
    {
        public readonly Dictionary<string, ExperimentAssignment> Assignments =
            new Dictionary<string, ExperimentAssignment>();
        public LinkedListNode<string> OrderNode;
    }

    public sealed class ExperimentResolver
    {
        readonly string _privacySalt;
        readonly Action<Dictionary<string, object>> _onExposure;
        readonly int _stateMaxSubjects;
        readonly Dictionary<string, ExperimentSubjectState> _stateBySubject =
            new Dictionary<string, ExperimentSubjectState>();
        readonly LinkedList<string> _subjectOrder = new LinkedList<string>();

        public ExperimentResolver(string privacySalt, int stateMaxSubjects, Action<Dictionary<string, object>> onExposure)
        {
            _privacySalt = privacySalt;
            _stateMaxSubjects = stateMaxSubjects;
            _onExposure = onExposure;
        }

        public int StateCount => _stateBySubject.Count;

        internal IEnumerable<string> StateIdentities => _stateBySubject.Keys;

        public string HashSubject(string subjectId)
        {
            return Hash.SubjectHash(_privacySalt, subjectId);
        }

        public ExperimentAssignment RecordAssignment(string subjectId, ExperimentDefinition experiment, VariantDefinition variant)
        {
            var subject = HashSubject(subjectId);
            if (!_stateBySubject.TryGetValue(subject, out var state))
            {
                while (_stateBySubject.Count >= _stateMaxSubjects)
                {
                    var oldest = _subjectOrder.First;
                    _subjectOrder.RemoveFirst();
                    _stateBySubject.Remove(oldest.Value);
                }
                state = new ExperimentSubjectState();
                state.OrderNode = _subjectOrder.AddLast(subject);
                _stateBySubject[subject] = state;
            }
            if (state.Assignments.TryGetValue(experiment.Id, out var known)) return known;
            var assignment = new ExperimentAssignment
            {
                Experiment = experiment.Id,
                Variant = variant.Key,
                GoalMetric = experiment.GoalMetric,
                Fingerprint = ExperimentFingerprint(experiment),
                Exposed = false
            };
            state.Assignments[experiment.Id] = assignment;
            return assignment;
        }

        public IReadOnlyList<ExperimentAssignment> AssignmentsFor(string subjectId)
        {
            if (_stateBySubject.TryGetValue(HashSubject(subjectId), out var state))
            {
                return new List<ExperimentAssignment>(state.Assignments.Values);
            }
            return Array.Empty<ExperimentAssignment>();
        }

        public object Resolve(
            string key,
            object remoteValue,
            string subjectId,
            Dictionary<string, List<ExperimentDefinition>> experimentsByKey)
        {
            if (subjectId == null) return remoteValue;
            if (!experimentsByKey.TryGetValue(key, out var list)) return remoteValue;
            foreach (var experiment in list)
            {
                var variant = Experiments.AssignVariant(experiment, subjectId);
                if (variant == null) continue;
                if (!variant.Values.TryGetValue(key, out var value)) continue;
                var assignment = RecordAssignment(subjectId, experiment, variant);
                Expose(assignment, subjectId);
                return value;
            }
            return remoteValue;
        }

        public ExperimentAssignment ExposedAssignmentForGoal(string subjectId, string goalMetric)
        {
            ExperimentAssignment match = null;
            foreach (var assignment in AssignmentsFor(subjectId))
            {
                if (!assignment.Exposed || assignment.GoalMetric != goalMetric) continue;
                if (match != null)
                {
                    throw new InvalidOperationException(
                        "goal metric " + goalMetric + " matches multiple exposed experiments"
                    );
                }
                match = assignment;
            }
            return match;
        }

        public void ApplySnapshot(IReadOnlyList<ExperimentDefinition> experiments)
        {
            var active = new Dictionary<string, string>();
            foreach (var experiment in experiments)
            {
                if (experiment.Enabled) active[experiment.Id] = ExperimentFingerprint(experiment);
            }
            var emptySubjects = new List<string>();
            foreach (var pair in _stateBySubject)
            {
                var obsolete = new List<string>();
                foreach (var assignment in pair.Value.Assignments)
                {
                    if (!active.TryGetValue(assignment.Key, out var fingerprint)
                        || fingerprint != assignment.Value.Fingerprint)
                    {
                        obsolete.Add(assignment.Key);
                    }
                }
                foreach (var experimentId in obsolete) pair.Value.Assignments.Remove(experimentId);
                if (pair.Value.Assignments.Count == 0) emptySubjects.Add(pair.Key);
            }
            foreach (var subject in emptySubjects)
            {
                var state = _stateBySubject[subject];
                _subjectOrder.Remove(state.OrderNode);
                _stateBySubject.Remove(subject);
            }
        }

        void Expose(ExperimentAssignment assignment, string subjectId)
        {
            if (assignment.Exposed) return;
            assignment.Exposed = true;
            var hashed = HashSubject(subjectId);
            _onExposure(new Dictionary<string, object>
            {
                ["experiment"] = assignment.Experiment,
                ["variant"] = assignment.Variant,
                ["subject"] = hashed
            });
        }

        static string ExperimentFingerprint(ExperimentDefinition experiment)
        {
            var variants = new List<object>();
            foreach (var variant in experiment.Variants)
            {
                var values = new SortedDictionary<string, object>(StringComparer.Ordinal);
                foreach (var value in variant.Values) values[value.Key] = value.Value;
                variants.Add(new Dictionary<string, object>
                {
                    ["key"] = variant.Key,
                    ["values"] = values,
                    ["weight"] = variant.Weight
                });
            }
            var canonical = new Dictionary<string, object>
            {
                ["allocation"] = experiment.Allocation,
                ["enabled"] = experiment.Enabled,
                ["goalMetric"] = experiment.GoalMetric,
                ["id"] = experiment.Id,
                ["primaryMetric"] = experiment.PrimaryMetric,
                ["salt"] = experiment.Salt,
                ["variants"] = variants
            };
            return Hash.SubjectHash("wardx.experiment.snapshot", Json.Stringify(canonical));
        }
    }

    public sealed class ConfigStore
    {
        public int Version { get; private set; }
        public Dictionary<string, object> Values { get; private set; } = new Dictionary<string, object>();
        public List<ExperimentDefinition> Experiments { get; private set; } = new List<ExperimentDefinition>();
        public Dictionary<string, List<ExperimentDefinition>> ExperimentsByKey { get; private set; } =
            new Dictionary<string, List<ExperimentDefinition>>();

        public void ApplySnapshot(int version, Dictionary<string, object> values, List<ExperimentDefinition> experiments)
        {
            if (experiments == null) experiments = new List<ExperimentDefinition>();
            foreach (var experiment in experiments)
            {
                if (string.IsNullOrEmpty(experiment.GoalMetric))
                {
                    throw new InvalidOperationException(
                        "experiment " + experiment.Id + " requires a non-empty goalMetric"
                    );
                }
            }
            Version = version;
            Values = values ?? new Dictionary<string, object>();
            Experiments = experiments;
            ExperimentsByKey = Wardx.Experiments.IndexByKey(Experiments);
        }

        public bool Has(string key)
        {
            return Values.ContainsKey(key);
        }

        public object GetRaw(string key)
        {
            return Values[key];
        }
    }
}
