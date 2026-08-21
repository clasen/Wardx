using System.Threading;
using System.Threading.Tasks;

namespace Wardx
{
    public interface ISyncTransport
    {
        Task<SyncResult> PostAsync(byte[] gzippedBody, CancellationToken cancellationToken);
        void Close();
    }

    public readonly struct SyncResult
    {
        public readonly bool Ok;
        public readonly int Status;
        public readonly string Text;

        public SyncResult(bool ok, int status, string text)
        {
            Ok = ok;
            Status = status;
            Text = text;
        }
    }

    public sealed class SdkIdentity
    {
        public string Name;
        public string Version;
        public string Platform;
    }
}
