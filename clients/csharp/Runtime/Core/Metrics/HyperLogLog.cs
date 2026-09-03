using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;

namespace Wardx
{
    public interface IDistinct
    {
        void Add(string identifier);
    }

    public sealed class HllBody
    {
        public readonly int Precision;
        public readonly string Registers;

        public HllBody(int precision, string registers)
        {
            Precision = precision;
            Registers = registers;
        }
    }

    public sealed class HyperLogLog : IDistinct
    {
        public const int Precision = 9;
        public const int RegisterCount = 1 << Precision;

        readonly string _privacySalt;
        readonly byte[] _registers = new byte[RegisterCount];

        public readonly string Name;
        public readonly IReadOnlyDictionary<string, object> Dims;
        public bool Dirty { get; private set; }

        public HyperLogLog(string name, IReadOnlyDictionary<string, object> dims, string privacySalt)
        {
            if (string.IsNullOrEmpty(privacySalt))
            {
                throw new ArgumentException("distinct requires a non-empty privacySalt");
            }
            Name = name;
            Dims = dims;
            _privacySalt = privacySalt;
        }

        public void Add(string identifier)
        {
            if (string.IsNullOrEmpty(identifier))
            {
                throw new ArgumentException("distinct.add requires a non-empty string");
            }
            byte[] digest;
            using (var sha = SHA256.Create())
            {
                digest = sha.ComputeHash(Encoding.UTF8.GetBytes(_privacySalt + "\0" + identifier));
            }
            var index = (digest[0] << 1) | (digest[1] >> 7);
            var rank = RankAfterIndex(digest);
            if (rank > _registers[index]) _registers[index] = rank;
            Dirty = true;
        }

        public HllBody Snapshot()
        {
            return new HllBody(Precision, Convert.ToBase64String(_registers));
        }

        public void Reset()
        {
            Array.Clear(_registers, 0, _registers.Length);
            Dirty = false;
        }

        static byte RankAfterIndex(byte[] digest)
        {
            byte rank = 1;
            for (var bit = Precision; bit < 64; bit++)
            {
                if ((digest[bit >> 3] & (1 << (7 - (bit & 7)))) != 0) return rank;
                rank++;
            }
            return rank;
        }
    }

    public sealed class NoopDistinct : IDistinct
    {
        public static readonly NoopDistinct Instance = new NoopDistinct();
        public void Add(string identifier) { }
    }
}
