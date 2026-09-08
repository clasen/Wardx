using System.Collections.Generic;

namespace Wardx
{
    public sealed class Dims : Dictionary<string, object>
    {
        public Dims() : base(4) { }

        public Dims(int capacity) : base(capacity) { }

        public static Dims Of(object k, object v)
        {
            return Of(EnumNames.Key(k), v);
        }

        public static Dims Of(object k1, object v1, object k2, object v2)
        {
            return Of(EnumNames.Key(k1), v1, EnumNames.Key(k2), v2);
        }

        public static Dims Of(object k1, object v1, object k2, object v2, object k3, object v3)
        {
            return Of(EnumNames.Key(k1), v1, EnumNames.Key(k2), v2, EnumNames.Key(k3), v3);
        }

        public static Dims Of(string k, object v)
        {
            return new Dims(1) { { k, v } };
        }

        public static Dims Of(string k1, object v1, string k2, object v2)
        {
            return new Dims(2) { { k1, v1 }, { k2, v2 } };
        }

        public static Dims Of(string k1, object v1, string k2, object v2, string k3, object v3)
        {
            return new Dims(3) { { k1, v1 }, { k2, v2 }, { k3, v3 } };
        }
    }
}
