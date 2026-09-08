using System;
using System.Text;
using System.IO;
using System.Text.Json;

namespace Wardx.Tests
{
    static class HashTests
    {
        public static void Run()
        {
            AssertX.Equal(0x811c9dc5u, Hash.Fnv1a32(""), "empty");
            AssertX.Equal(0xe40c292cu, Hash.Fnv1a32("a"), "a");
            AssertX.Equal(0xbf9cf968u, Hash.Fnv1a32("foobar"), "foobar");
            var viaString = Hash.Fnv1a32("é");
            var viaBytes = Hash.Fnv1a32(Encoding.UTF8.GetBytes("é"));
            AssertX.Equal(viaString, viaBytes, "utf8 string vs bytes");
            AssertX.True(viaString != Hash.Fnv1a32(new byte[] { 0xe9 }), "not latin-1");
            AssertX.Equal(Hash.Fnv1a32("costarring"), Hash.Fnv1a32("liquid"), "known fnv collision");
            var firstSubject = Hash.SubjectHash("test-salt", "costarring");
            var secondSubject = Hash.SubjectHash("test-salt", "liquid");
            AssertX.Equal(16, firstSubject.Length, "xxhash64 subject width");
            AssertX.True(firstSubject != secondSubject, "xxhash64 separates fnv collision");
            using var vectors = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "xxhash64.json")));
            foreach (var vector in vectors.RootElement.GetProperty("raw").EnumerateArray())
            {
                var bytes = Convert.FromBase64String(vector.GetProperty("input").GetString());
                AssertX.Equal(vector.GetProperty("hash").GetString(), Hash.XxHash64(bytes).ToString("x16"), "xxhash64 bytes");
            }
            foreach (var vector in vectors.RootElement.GetProperty("subjects").EnumerateArray())
            {
                var salt = vector.GetProperty("salt").GetString();
                var subject = vector.GetProperty("subject").GetString();
                AssertX.Equal(vector.GetProperty("hash").GetString(), Hash.SubjectHash(salt, subject), "subject hash");
                if (salt.Length == 0 || subject.Length == 0) continue;
                var hll = new HyperLogLog("users", null, salt);
                hll.Add(subject);
                hll.Add(subject);
                var registers = Convert.FromBase64String(hll.Snapshot().Registers);
                var index = vector.GetProperty("index").GetInt32();
                var rank = vector.GetProperty("rank").GetByte();
                for (var i = 0; i < registers.Length; i++)
                {
                    AssertX.Equal(i == index ? rank : (byte)0, registers[i], "shared HLL register");
                }
            }
        }
    }
}
