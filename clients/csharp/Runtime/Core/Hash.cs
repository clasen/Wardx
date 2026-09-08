using System;
using System.Text;
using System.Buffers.Binary;

namespace Wardx
{
    public static class Hash
    {
        public const uint FnvOffset32 = 0x811c9dc5;
        public const uint FnvPrime32 = 0x01000193;
        public const double Uint32 = 4294967296.0;

        public static uint Fnv1a32(string input)
        {
            if (input == null) throw new ArgumentNullException(nameof(input));
            return Fnv1a32(Encoding.UTF8.GetBytes(input));
        }

        public static uint Fnv1a32(byte[] bytes)
        {
            if (bytes == null) throw new ArgumentNullException(nameof(bytes));
            uint hash = FnvOffset32;
            for (int i = 0; i < bytes.Length; i++)
            {
                hash ^= bytes[i];
                hash *= FnvPrime32;
            }
            return hash;
        }

        public static double HashToUnitInterval(uint hash)
        {
            return hash / Uint32;
        }

        public static uint AssignmentHash(string experimentId, string subjectId, string salt)
        {
            return Fnv1a32(experimentId + ":" + subjectId + ":" + salt);
        }

        public static string SubjectHash(string projectSalt, string subjectId)
        {
            return SubjectHash64(projectSalt, subjectId).ToString("x16");
        }

        internal static ulong SubjectHash64(string projectSalt, string subjectId)
        {
            return XxHash64(Encoding.UTF8.GetBytes(projectSalt + "\0" + subjectId));
        }

        const ulong Prime1 = 11400714785074694791UL;
        const ulong Prime2 = 14029467366897019727UL;
        const ulong Prime3 = 1609587929392839161UL;
        const ulong Prime4 = 9650029242287828579UL;
        const ulong Prime5 = 2870177450012600261UL;

        static ulong RotateLeft(ulong value, int count)
        {
            return (value << count) | (value >> (64 - count));
        }

        static ulong Round(ulong accumulator, ulong lane)
        {
            return unchecked(RotateLeft(accumulator + lane * Prime2, 31) * Prime1);
        }

        static ulong MergeRound(ulong accumulator, ulong lane)
        {
            return unchecked((accumulator ^ Round(0, lane)) * Prime1 + Prime4);
        }

        internal static ulong XxHash64(byte[] bytes)
        {
            if (bytes == null) throw new ArgumentNullException(nameof(bytes));
            unchecked
            {
                int offset = 0;
                ulong hash;
                if (bytes.Length >= 32)
                {
                    ulong v1 = Prime1 + Prime2;
                    ulong v2 = Prime2;
                    ulong v3 = 0;
                    ulong v4 = 0UL - Prime1;
                    do
                    {
                        v1 = Round(v1, BinaryPrimitives.ReadUInt64LittleEndian(bytes.AsSpan(offset)));
                        v2 = Round(v2, BinaryPrimitives.ReadUInt64LittleEndian(bytes.AsSpan(offset + 8)));
                        v3 = Round(v3, BinaryPrimitives.ReadUInt64LittleEndian(bytes.AsSpan(offset + 16)));
                        v4 = Round(v4, BinaryPrimitives.ReadUInt64LittleEndian(bytes.AsSpan(offset + 24)));
                        offset += 32;
                    } while (offset <= bytes.Length - 32);
                    hash = RotateLeft(v1, 1) + RotateLeft(v2, 7) + RotateLeft(v3, 12) + RotateLeft(v4, 18);
                    hash = MergeRound(hash, v1);
                    hash = MergeRound(hash, v2);
                    hash = MergeRound(hash, v3);
                    hash = MergeRound(hash, v4);
                }
                else hash = Prime5;
                hash += (ulong)bytes.Length;
                while (offset <= bytes.Length - 8)
                {
                    hash ^= Round(0, BinaryPrimitives.ReadUInt64LittleEndian(bytes.AsSpan(offset)));
                    hash = RotateLeft(hash, 27) * Prime1 + Prime4;
                    offset += 8;
                }
                if (offset <= bytes.Length - 4)
                {
                    hash ^= BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(offset)) * Prime1;
                    hash = RotateLeft(hash, 23) * Prime2 + Prime3;
                    offset += 4;
                }
                while (offset < bytes.Length)
                {
                    hash ^= bytes[offset++] * Prime5;
                    hash = RotateLeft(hash, 11) * Prime1;
                }
                hash ^= hash >> 33;
                hash *= Prime2;
                hash ^= hash >> 29;
                hash *= Prime3;
                return hash ^ (hash >> 32);
            }
        }
    }
}
