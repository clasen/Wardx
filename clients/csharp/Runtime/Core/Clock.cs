using System;

namespace Wardx
{
    public static class Clock
    {
        public static long UnixMs()
        {
            return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        }
    }
}
