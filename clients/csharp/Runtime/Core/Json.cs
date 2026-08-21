using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Wardx
{
    public static class Json
    {
        public static string Stringify(object value)
        {
            var sb = new StringBuilder();
            Write(sb, value);
            return sb.ToString();
        }

        public static int Utf8ByteLength(object value)
        {
            return Encoding.UTF8.GetByteCount(Stringify(value));
        }

        public static JsonNode Parse(string json)
        {
            if (json == null) throw new ArgumentNullException(nameof(json));
            var parser = new Parser(json);
            var node = parser.ParseValue();
            parser.SkipWs();
            if (!parser.Done) throw new FormatException("unexpected trailing JSON");
            return node;
        }

        static void Write(StringBuilder sb, object value)
        {
            if (value == null)
            {
                sb.Append("null");
                return;
            }
            switch (value)
            {
                case string s:
                    WriteString(sb, s);
                    return;
                case bool b:
                    sb.Append(b ? "true" : "false");
                    return;
                case JsonNode node:
                    Write(sb, node.Native());
                    return;
                case IReadOnlyDictionary<string, object> dict:
                    WriteObject(sb, dict);
                    return;
                case IDictionary<string, object> dict2:
                    WriteObject(sb, dict2);
                    return;
                case IDictionary dict3:
                    WriteObject(sb, dict3);
                    return;
                case IEnumerable list when !(value is string):
                    WriteArray(sb, list);
                    return;
            }
            if (TryNumber(value, out var number, out var integer, out var isInt))
            {
                if (isInt) sb.Append(integer.ToString(CultureInfo.InvariantCulture));
                else sb.Append(number.ToString("G17", CultureInfo.InvariantCulture));
                return;
            }
            throw new InvalidOperationException("cannot JSON-encode " + value.GetType().FullName);
        }

        static void WriteObject(StringBuilder sb, IEnumerable pairs)
        {
            sb.Append('{');
            var first = true;
            if (pairs is IReadOnlyDictionary<string, object> ro)
            {
                foreach (var pair in ro)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    WriteString(sb, pair.Key);
                    sb.Append(':');
                    Write(sb, pair.Value);
                }
            }
            else if (pairs is IDictionary<string, object> d)
            {
                foreach (var pair in d)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    WriteString(sb, pair.Key);
                    sb.Append(':');
                    Write(sb, pair.Value);
                }
            }
            else
            {
                foreach (DictionaryEntry pair in (IDictionary)pairs)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    WriteString(sb, Convert.ToString(pair.Key, CultureInfo.InvariantCulture));
                    sb.Append(':');
                    Write(sb, pair.Value);
                }
            }
            sb.Append('}');
        }

        static void WriteArray(StringBuilder sb, IEnumerable list)
        {
            sb.Append('[');
            var first = true;
            foreach (var item in list)
            {
                if (!first) sb.Append(',');
                first = false;
                Write(sb, item);
            }
            sb.Append(']');
        }

        static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            for (int i = 0; i < s.Length; i++)
            {
                var c = s[i];
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20)
                        {
                            sb.Append("\\u");
                            sb.Append(((int)c).ToString("x4"));
                        }
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        static bool TryNumber(object value, out double number, out long integer, out bool isInt)
        {
            number = 0;
            integer = 0;
            isInt = false;
            switch (value)
            {
                case sbyte x: integer = x; isInt = true; return true;
                case byte x: integer = x; isInt = true; return true;
                case short x: integer = x; isInt = true; return true;
                case ushort x: integer = x; isInt = true; return true;
                case int x: integer = x; isInt = true; return true;
                case uint x: integer = x; isInt = true; return true;
                case long x: integer = x; isInt = true; return true;
                case ulong x:
                    if (x > long.MaxValue) { number = x; return true; }
                    integer = (long)x;
                    isInt = true;
                    return true;
                case float f:
                    if (float.IsNaN(f) || float.IsInfinity(f)) return false;
                    number = f;
                    if (f == Math.Truncate(f) && f >= long.MinValue && f <= long.MaxValue)
                    {
                        integer = (long)f;
                        isInt = true;
                    }
                    return true;
                case double d:
                    if (double.IsNaN(d) || double.IsInfinity(d)) return false;
                    number = d;
                    if (d == Math.Truncate(d) && d >= long.MinValue && d <= long.MaxValue)
                    {
                        integer = (long)d;
                        isInt = true;
                    }
                    return true;
                case decimal m:
                    number = (double)m;
                    if (m == decimal.Truncate(m) && m >= long.MinValue && m <= long.MaxValue)
                    {
                        integer = (long)m;
                        isInt = true;
                    }
                    return true;
                default:
                    return false;
            }
        }

        sealed class Parser
        {
            readonly string _s;
            int _i;

            public Parser(string s)
            {
                _s = s;
            }

            public bool Done => _i >= _s.Length;

            public void SkipWs()
            {
                while (_i < _s.Length)
                {
                    var c = _s[_i];
                    if (c == ' ' || c == '\n' || c == '\r' || c == '\t') _i++;
                    else break;
                }
            }

            public JsonNode ParseValue()
            {
                SkipWs();
                if (_i >= _s.Length) throw new FormatException("unexpected end of JSON");
                var c = _s[_i];
                if (c == '{') return ParseObject();
                if (c == '[') return ParseArray();
                if (c == '"') return JsonNode.Str(ParseString());
                if (c == 't') { Expect("true"); return JsonNode.Bool(true); }
                if (c == 'f') { Expect("false"); return JsonNode.Bool(false); }
                if (c == 'n') { Expect("null"); return JsonNode.Null(); }
                if (c == '-' || (c >= '0' && c <= '9')) return ParseNumber();
                throw new FormatException("unexpected JSON at " + _i);
            }

            JsonNode ParseObject()
            {
                _i++;
                var obj = new Dictionary<string, JsonNode>();
                SkipWs();
                if (Peek() == '}') { _i++; return JsonNode.Obj(obj); }
                while (true)
                {
                    SkipWs();
                    if (Peek() != '"') throw new FormatException("expected object key");
                    var key = ParseString();
                    SkipWs();
                    if (Peek() != ':') throw new FormatException("expected colon");
                    _i++;
                    obj[key] = ParseValue();
                    SkipWs();
                    var next = Peek();
                    if (next == ',') { _i++; continue; }
                    if (next == '}') { _i++; break; }
                    throw new FormatException("expected comma or end of object");
                }
                return JsonNode.Obj(obj);
            }

            JsonNode ParseArray()
            {
                _i++;
                var list = new List<JsonNode>();
                SkipWs();
                if (Peek() == ']') { _i++; return JsonNode.Arr(list); }
                while (true)
                {
                    list.Add(ParseValue());
                    SkipWs();
                    var next = Peek();
                    if (next == ',') { _i++; continue; }
                    if (next == ']') { _i++; break; }
                    throw new FormatException("expected comma or end of array");
                }
                return JsonNode.Arr(list);
            }

            string ParseString()
            {
                _i++;
                var sb = new StringBuilder();
                while (_i < _s.Length)
                {
                    var c = _s[_i++];
                    if (c == '"') return sb.ToString();
                    if (c != '\\')
                    {
                        sb.Append(c);
                        continue;
                    }
                    if (_i >= _s.Length) throw new FormatException("unterminated string escape");
                    var e = _s[_i++];
                    switch (e)
                    {
                        case '"':
                        case '\\':
                        case '/':
                            sb.Append(e);
                            break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'u':
                            if (_i + 4 > _s.Length) throw new FormatException("bad unicode escape");
                            var hex = _s.Substring(_i, 4);
                            sb.Append((char)Convert.ToInt32(hex, 16));
                            _i += 4;
                            break;
                        default:
                            throw new FormatException("bad string escape");
                    }
                }
                throw new FormatException("unterminated string");
            }

            JsonNode ParseNumber()
            {
                var start = _i;
                if (Peek() == '-') _i++;
                if (Peek() == '0') _i++;
                else
                {
                    if (Peek() < '1' || Peek() > '9') throw new FormatException("bad number");
                    while (Peek() >= '0' && Peek() <= '9') _i++;
                }
                var isFloat = false;
                if (Peek() == '.')
                {
                    isFloat = true;
                    _i++;
                    if (Peek() < '0' || Peek() > '9') throw new FormatException("bad number fraction");
                    while (Peek() >= '0' && Peek() <= '9') _i++;
                }
                var exp = Peek();
                if (exp == 'e' || exp == 'E')
                {
                    isFloat = true;
                    _i++;
                    if (Peek() == '+' || Peek() == '-') _i++;
                    if (Peek() < '0' || Peek() > '9') throw new FormatException("bad number exponent");
                    while (Peek() >= '0' && Peek() <= '9') _i++;
                }
                var text = _s.Substring(start, _i - start);
                var d = double.Parse(text, CultureInfo.InvariantCulture);
                return JsonNode.Num(d, isFloat);
            }

            void Expect(string token)
            {
                if (_i + token.Length > _s.Length || _s.Substring(_i, token.Length) != token)
                {
                    throw new FormatException("expected " + token);
                }
                _i += token.Length;
            }

            char Peek()
            {
                return _i < _s.Length ? _s[_i] : '\0';
            }
        }
    }

    public sealed class JsonNode
    {
        public enum Kind { Null, Bool, Number, String, Array, Object }

        public Kind Type;
        public bool BoolValue;
        public double NumberValue;
        public bool NumberWasFloat;
        public string StringValue;
        public List<JsonNode> ArrayValue;
        public Dictionary<string, JsonNode> ObjectValue;

        public static JsonNode Null() { return new JsonNode { Type = Kind.Null }; }
        public static JsonNode Bool(bool v) { return new JsonNode { Type = Kind.Bool, BoolValue = v }; }
        public static JsonNode Num(double v, bool wasFloat) { return new JsonNode { Type = Kind.Number, NumberValue = v, NumberWasFloat = wasFloat }; }
        public static JsonNode Str(string v) { return new JsonNode { Type = Kind.String, StringValue = v }; }
        public static JsonNode Arr(List<JsonNode> v) { return new JsonNode { Type = Kind.Array, ArrayValue = v }; }
        public static JsonNode Obj(Dictionary<string, JsonNode> v) { return new JsonNode { Type = Kind.Object, ObjectValue = v }; }

        public bool IsNull => Type == Kind.Null;
        public bool IsObject => Type == Kind.Object;
        public bool IsBool => Type == Kind.Bool;

        public JsonNode this[string key]
        {
            get
            {
                if (Type != Kind.Object || !ObjectValue.TryGetValue(key, out var node)) return null;
                return node;
            }
        }

        public bool Has(string key)
        {
            return Type == Kind.Object && ObjectValue.ContainsKey(key);
        }

        public object Native()
        {
            switch (Type)
            {
                case Kind.Null: return null;
                case Kind.Bool: return BoolValue;
                case Kind.Number:
                    if (!NumberWasFloat && NumberValue == Math.Truncate(NumberValue) &&
                        NumberValue >= int.MinValue && NumberValue <= int.MaxValue)
                    {
                        return (int)NumberValue;
                    }
                    if (!NumberWasFloat && NumberValue == Math.Truncate(NumberValue) &&
                        NumberValue >= long.MinValue && NumberValue <= long.MaxValue)
                    {
                        return (long)NumberValue;
                    }
                    return NumberValue;
                case Kind.String: return StringValue;
                case Kind.Array:
                    var list = new List<object>(ArrayValue.Count);
                    foreach (var item in ArrayValue) list.Add(item.Native());
                    return list;
                case Kind.Object:
                    var dict = new Dictionary<string, object>(ObjectValue.Count);
                    foreach (var pair in ObjectValue) dict[pair.Key] = pair.Value.Native();
                    return dict;
                default:
                    return null;
            }
        }

        public Dictionary<string, object> ObjectNative()
        {
            if (Type != Kind.Object) return null;
            var dict = new Dictionary<string, object>(ObjectValue.Count);
            foreach (var pair in ObjectValue) dict[pair.Key] = pair.Value.Native();
            return dict;
        }
    }
}
