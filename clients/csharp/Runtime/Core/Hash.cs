using System;
using System.Text;
using System.Security.Cryptography;

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
            var bytes = Encoding.UTF8.GetBytes(projectSalt + "\0" + subjectId);
            using (var sha = SHA256.Create())
            {
                var digest = sha.ComputeHash(bytes);
                var hex = new StringBuilder(digest.Length * 2);
                for (int i = 0; i < digest.Length; i++) hex.Append(digest[i].ToString("x2"));
                return hex.ToString();
            }
        }
    }
}
