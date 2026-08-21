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
        }
    }
}
