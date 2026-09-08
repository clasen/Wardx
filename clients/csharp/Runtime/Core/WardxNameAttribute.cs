using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Reflection;

namespace Wardx
{
    [AttributeUsage(AttributeTargets.Field)]
    public sealed class WardxNameAttribute : Attribute
    {
        public string Name { get; }

        public WardxNameAttribute(string name)
        {
            if (string.IsNullOrWhiteSpace(name)) throw new ArgumentException("Wardx name must be nonblank", nameof(name));
            Name = name;
        }
    }

    static class EnumNames
    {
        static readonly ConcurrentDictionary<Enum, string> Names = new ConcurrentDictionary<Enum, string>();

        public static string Resolve(Enum value)
        {
            return Names.GetOrAdd(value, ReadName);
        }

        static string ReadName(Enum value)
        {
            FieldInfo member = null;
            foreach (var field in value.GetType().GetFields(BindingFlags.Public | BindingFlags.Static))
            {
                if (!value.Equals(field.GetValue(null))) continue;
                if (member != null) throw new ArgumentException("Wardx enum aliases are ambiguous");
                member = field;
            }
            if (member == null) throw new ArgumentException("Wardx enum value must have a declared member");
            return member.GetCustomAttribute<WardxNameAttribute>()?.Name ?? member.Name;
        }

        public static string Key(object value)
        {
            if (value is string text) return text;
            if (value is Enum member) return Resolve(member);
            throw new ArgumentException("dimension key must be a string or enum");
        }

        public static IReadOnlyDictionary<string, object> Normalize(IReadOnlyDictionary<string, object> values)
        {
            if (values == null) return null;
            Dictionary<string, object> copy = null;
            foreach (var pair in values)
            {
                if (!(pair.Value is Enum member)) continue;
                if (copy == null)
                {
                    copy = new Dictionary<string, object>(values.Count);
                    foreach (var entry in values) copy.Add(entry.Key, entry.Value);
                }
                copy[pair.Key] = Resolve(member);
            }
            return copy ?? values;
        }
    }
}
