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
    }

    public sealed class ExperimentResolver
    {
        readonly string _privacySalt;
        readonly Action<Dictionary<string, object>> _onExposure;
        readonly HashSet<string> _exposureKeys = new HashSet<string>();
        readonly Dictionary<string, List<ExperimentAssignment>> _assignmentsBySubject = new Dictionary<string, List<ExperimentAssignment>>();

        public ExperimentResolver(string privacySalt, Action<Dictionary<string, object>> onExposure)
        {
            _privacySalt = privacySalt;
            _onExposure = onExposure;
        }

        public string HashSubject(string subjectId)
        {
            return Hash.SubjectHash(_privacySalt, subjectId);
        }

        public void RecordAssignment(string subjectId, ExperimentDefinition experiment, VariantDefinition variant)
        {
            if (!_assignmentsBySubject.TryGetValue(subjectId, out var list))
            {
                list = new List<ExperimentAssignment>();
                _assignmentsBySubject[subjectId] = list;
            }
            for (int i = 0; i < list.Count; i++)
            {
                if (list[i].Experiment == experiment.Id) return;
            }
            list.Add(new ExperimentAssignment { Experiment = experiment.Id, Variant = variant.Key });
        }

        public IReadOnlyList<ExperimentAssignment> AssignmentsFor(string subjectId)
        {
            if (_assignmentsBySubject.TryGetValue(subjectId, out var list)) return list;
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
                RecordAssignment(subjectId, experiment, variant);
                Expose(experiment, variant, subjectId);
                return value;
            }
            return remoteValue;
        }

        public List<ExperimentAssignment> RelevantExperiments(string subjectId, IReadOnlyList<ExperimentDefinition> experiments)
        {
            var known = AssignmentsFor(subjectId);
            if (known.Count > 0)
            {
                var copy = new List<ExperimentAssignment>(known.Count);
                foreach (var row in known) copy.Add(row);
                return copy;
            }
            var attached = new List<ExperimentAssignment>();
            if (experiments == null) return attached;
            foreach (var experiment in experiments)
            {
                if (!experiment.Enabled) continue;
                var variant = Experiments.AssignVariant(experiment, subjectId);
                if (variant == null) continue;
                attached.Add(new ExperimentAssignment { Experiment = experiment.Id, Variant = variant.Key });
            }
            return attached;
        }

        void Expose(ExperimentDefinition experiment, VariantDefinition variant, string subjectId)
        {
            var hashed = HashSubject(subjectId);
            var exposureKey = experiment.Id + "\0" + hashed;
            if (_exposureKeys.Contains(exposureKey)) return;
            _exposureKeys.Add(exposureKey);
            _onExposure(new Dictionary<string, object>
            {
                ["experiment"] = experiment.Id,
                ["variant"] = variant.Key,
                ["subject"] = hashed
            });
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
            Version = version;
            Values = values ?? new Dictionary<string, object>();
            Experiments = experiments ?? new List<ExperimentDefinition>();
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
