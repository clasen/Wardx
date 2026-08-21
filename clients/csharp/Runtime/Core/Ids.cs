using System;
using System.Security.Cryptography;

namespace Wardx
{
    public static class Ids
    {
        const string Encoding = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

        public static string Ulid()
        {
            return Ulid(Clock.UnixMs());
        }

        public static string Ulid(long now)
        {
            var chars = new char[26];
            long time = now;
            for (int i = 9; i >= 0; i--)
            {
                chars[i] = Encoding[(int)(time & 31)];
                time /= 32;
            }
            var rand = new byte[10];
            using (var rng = RandomNumberGenerator.Create())
            {
                rng.GetBytes(rand);
            }
            chars[10] = Encoding[(rand[0] & 224) >> 5];
            chars[11] = Encoding[rand[0] & 31];
            chars[12] = Encoding[(rand[1] & 248) >> 3];
            chars[13] = Encoding[((rand[1] & 7) << 2) | ((rand[2] & 192) >> 6)];
            chars[14] = Encoding[(rand[2] & 62) >> 1];
            chars[15] = Encoding[((rand[2] & 1) << 4) | ((rand[3] & 240) >> 4)];
            chars[16] = Encoding[((rand[3] & 15) << 1) | ((rand[4] & 128) >> 7)];
            chars[17] = Encoding[(rand[4] & 124) >> 2];
            chars[18] = Encoding[((rand[4] & 3) << 3) | ((rand[5] & 224) >> 5)];
            chars[19] = Encoding[rand[5] & 31];
            chars[20] = Encoding[(rand[6] & 248) >> 3];
            chars[21] = Encoding[((rand[6] & 7) << 2) | ((rand[7] & 192) >> 6)];
            chars[22] = Encoding[(rand[7] & 62) >> 1];
            chars[23] = Encoding[((rand[7] & 1) << 4) | ((rand[8] & 240) >> 4)];
            chars[24] = Encoding[((rand[8] & 15) << 1) | ((rand[9] & 128) >> 7)];
            chars[25] = Encoding[(rand[9] & 124) >> 2];
            return new string(chars);
        }
    }
}
