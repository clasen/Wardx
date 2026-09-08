using System;
using System.Collections.Generic;
using System.Text;

namespace Wardx
{
    public static class Dimensions
    {
        public static string DimKey(IReadOnlyDictionary<string, object> dims)
        {
            if (dims == null || dims.Count == 0) return "";
            if (dims.Count == 1)
            {
                foreach (var pair in dims)
                {
                    return pair.Key + "=" + Convert.ToString(pair.Value, System.Globalization.CultureInfo.InvariantCulture);
                }
            }
            var keys = new string[dims.Count];
            var i = 0;
            foreach (var key in dims.Keys) keys[i++] = key;
            Array.Sort(keys, StringComparer.Ordinal);
            var sb = new StringBuilder();
            for (i = 0; i < keys.Length; i++)
            {
                if (i > 0) sb.Append('\n');
                sb.Append(keys[i]);
                sb.Append('=');
                sb.Append(Convert.ToString(dims[keys[i]], System.Globalization.CultureInfo.InvariantCulture));
            }
            return sb.ToString();
        }

        public static DimensionCheck Validate(IReadOnlyDictionary<string, object> dims, int maxDimensionKeys, int maxDimensionValueLength)
        {
            if (dims == null) return DimensionCheck.Success(null);
            if (dims.Count == 0) return DimensionCheck.Success(null);
            if (dims.Count > maxDimensionKeys)
            {
                return DimensionCheck.Fail("maxDimensionKeys");
            }
            dims = EnumNames.Normalize(dims);
            foreach (var pair in dims)
            {
                var value = pair.Value;
                if (value is string || value is bool || IsFiniteNumber(value))
                {
                    var text = Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture);
                    if (text.Length > maxDimensionValueLength)
                    {
                        return DimensionCheck.Fail("maxDimensionValueLength");
                    }
                    continue;
                }
                throw new ArgumentException("dimension " + pair.Key + " must be string, number, or boolean");
            }
            return DimensionCheck.Success(Copy(dims));
        }

        public static void AssertMetricName(string name)
        {
            if (string.IsNullOrEmpty(name))
            {
                throw new ArgumentException("metric name must be a non-empty string");
            }
        }

        public static IReadOnlyDictionary<string, object> Copy(IReadOnlyDictionary<string, object> dims)
        {
            if (dims == null || dims.Count == 0) return null;
            var copy = new Dictionary<string, object>(dims.Count);
            foreach (var pair in dims) copy[pair.Key] = pair.Value;
            return copy;
        }

        public static IReadOnlyDictionary<string, object> Merge(
            IReadOnlyDictionary<string, object> start,
            IReadOnlyDictionary<string, object> end)
        {
            if (end == null || end.Count == 0) return start;
            if (start == null || start.Count == 0) return Copy(end);
            var merged = new Dictionary<string, object>(start.Count + end.Count);
            foreach (var pair in start) merged[pair.Key] = pair.Value;
            foreach (var pair in end) merged[pair.Key] = pair.Value;
            return merged;
        }

        static bool IsFiniteNumber(object value)
        {
            if (value is sbyte || value is byte || value is short || value is ushort ||
                value is int || value is uint || value is long || value is ulong)
            {
                return true;
            }
            if (value is float f) return !float.IsNaN(f) && !float.IsInfinity(f);
            if (value is double d) return !double.IsNaN(d) && !double.IsInfinity(d);
            if (value is decimal) return true;
            return false;
        }
    }

    public readonly struct DimensionCheck
    {
        public readonly bool IsOk;
        public readonly string Reason;
        public readonly IReadOnlyDictionary<string, object> Dims;

        DimensionCheck(bool isOk, string reason, IReadOnlyDictionary<string, object> dims)
        {
            IsOk = isOk;
            Reason = reason;
            Dims = dims;
        }

        public static DimensionCheck Success(IReadOnlyDictionary<string, object> dims)
        {
            return new DimensionCheck(true, null, dims);
        }

        public static DimensionCheck Fail(string reason)
        {
            return new DimensionCheck(false, reason, null);
        }
    }
}
