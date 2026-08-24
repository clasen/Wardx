using System;
using System.Text;

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
            AssertX.Equal(64, firstSubject.Length, "sha-256 subject width");
            AssertX.True(firstSubject != secondSubject, "sha-256 separates fnv collision");
            AssertX.Equal(
                "0199ba4aea1913bcc6519b7c625951855764717ecccc8fd914182a41b59b0a69",
                Hash.SubjectHash("test-salt", "user-1"),
                "node/csharp subject fixture"
            );
        }
    }
}
