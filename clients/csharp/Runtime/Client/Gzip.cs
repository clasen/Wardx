using System.IO;
using System.IO.Compression;
using System.Text;

namespace Wardx
{
    public static class Gzip
    {
        public static byte[] Compress(string json)
        {
            return Compress(Encoding.UTF8.GetBytes(json));
        }

        internal static byte[] Compress(byte[] bytes)
        {
            using (var output = new MemoryStream())
            {
                using (var gzip = new GZipStream(output, CompressionLevel.Optimal, true))
                {
                    gzip.Write(bytes, 0, bytes.Length);
                }
                return output.ToArray();
            }
        }
    }
}
