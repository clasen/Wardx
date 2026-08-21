#if UNITY
using System;
using System.Collections;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;
using UnityEngine.Networking;
using UnityEngine.Profiling;

namespace Wardx
{
    public sealed class UnityWebRequestTransport : ISyncTransport
    {
        readonly MonoBehaviour _runner;
        readonly string _url;
        readonly string _projectKey;
        readonly int _timeoutSeconds;

        public UnityWebRequestTransport(MonoBehaviour runner, string endpoint, string projectKey, int httpTimeoutMs)
        {
            _runner = runner;
            _url = SyncUrl(endpoint);
            _projectKey = projectKey;
            _timeoutSeconds = Math.Max(1, (httpTimeoutMs + 999) / 1000);
        }

        public Task<SyncResult> PostAsync(byte[] gzippedBody, CancellationToken cancellationToken)
        {
            var tcs = new TaskCompletionSource<SyncResult>(TaskCreationOptions.RunContinuationsAsynchronously);
            _runner.StartCoroutine(Post(gzippedBody, tcs, cancellationToken));
            return tcs.Task;
        }

        public void Close() { }

        IEnumerator Post(byte[] body, TaskCompletionSource<SyncResult> tcs, CancellationToken cancellationToken)
        {
            var request = new UnityWebRequest(_url, UnityWebRequest.kHttpVerbPOST);
            request.uploadHandler = new UploadHandlerRaw(body);
            request.downloadHandler = new DownloadHandlerBuffer();
            request.SetRequestHeader("Content-Type", "application/json");
            request.SetRequestHeader("Content-Encoding", "gzip");
            request.SetRequestHeader("X-Wardx-Key", _projectKey);
            request.SetRequestHeader("Accept", "application/json");
            request.timeout = _timeoutSeconds;
            var op = request.SendWebRequest();
            while (!op.isDone)
            {
                if (cancellationToken.IsCancellationRequested)
                {
                    request.Abort();
                    request.Dispose();
                    tcs.TrySetCanceled(cancellationToken);
                    yield break;
                }
                yield return null;
            }
            try
            {
                var status = (int)request.responseCode;
                var text = request.downloadHandler != null ? request.downloadHandler.text : "";
                tcs.TrySetResult(new SyncResult(status >= 200 && status < 300, status, text));
            }
            finally
            {
                request.Dispose();
            }
        }

        public static string SyncUrl(string endpoint)
        {
            var uri = new Uri(endpoint);
            if (uri.AbsolutePath == "/" || uri.AbsolutePath == "")
            {
                return new Uri(uri, "/v1/sync").ToString();
            }
            return endpoint;
        }
    }

    sealed class WardxHost : MonoBehaviour
    {
        WardxClient _client;
        Settings _settings;
        Coroutine _syncLoop;
        bool _stopping;

        public void Bind(WardxClient client, Settings settings)
        {
            _client = client;
            _settings = settings;
            DontDestroyOnLoad(gameObject);
            InvokeRepeating(nameof(Aggregate), settings.AggregateIntervalMs / 1000f, settings.AggregateIntervalMs / 1000f);
            _syncLoop = StartCoroutine(SyncLoop());
            client.AttachScheduler(() =>
            {
                _stopping = true;
                CancelInvoke(nameof(Aggregate));
                if (_syncLoop != null) StopCoroutine(_syncLoop);
            });
        }

        void Aggregate()
        {
            if (_stopping || _client == null) return;
            _client.AggregateTick();
        }

        IEnumerator SyncLoop()
        {
            var bootstrap = _client.EnqueueSync(new SyncFlags { Bootstrap = true });
            while (!bootstrap.IsCompleted) yield return null;
            while (!_stopping)
            {
                var delay = Math.Max(1, Settings.NextSyncDelayMs(_settings)) / 1000f;
                yield return new WaitForSecondsRealtime(delay);
                if (_stopping) yield break;
                var task = _client.EnqueueSync(default);
                while (!task.IsCompleted) yield return null;
            }
        }

        void OnApplicationQuit()
        {
            if (_client == null) return;
            _client.Stop();
        }
    }

    static class UnityBootstrap
    {
        public static WardxClient Start(Settings settings)
        {
            var hostObject = new GameObject("Wardx");
            var host = hostObject.AddComponent<WardxHost>();
            return Attach(host, settings);
        }

        public static WardxClient Attach(MonoBehaviour hostBehaviour, Settings settings)
        {
            var transport = new UnityWebRequestTransport(hostBehaviour, settings.Endpoint, settings.ProjectKey, settings.HttpTimeoutMs);
            var client = new WardxClient(
                settings,
                transport,
                () =>
                {
                    try { return Profiler.GetTotalAllocatedMemoryLong(); }
                    catch { return 0; }
                },
                new SdkIdentity
                {
                    Name = "wardx-unity",
                    Version = SdkDefaults.Version,
                    Platform = "unity"
                }
            );
            var host = hostBehaviour as WardxHost;
            if (host == null) host = hostBehaviour.gameObject.AddComponent<WardxHost>();
            host.Bind(client, settings);
            return client;
        }
    }

    public sealed class WardxBehaviour : MonoBehaviour
    {
        public string endpoint = "http://127.0.0.1:8787";
        public string projectKey;
        public string project;
        public string role = "unity";
        public string appVersion;
        public string environment = "production";
        public string privacySalt;

        public WardxClient Client { get; private set; }

        void Awake()
        {
            if (string.IsNullOrEmpty(appVersion)) appVersion = Application.version;
            Client = UnityBootstrap.Attach(this, Settings.Resolve(new WardxOptions
            {
                Endpoint = endpoint,
                ProjectKey = projectKey,
                Project = project,
                Role = role,
                AppVersion = appVersion,
                Environment = environment,
                PrivacySalt = string.IsNullOrEmpty(privacySalt) ? null : privacySalt
            }));
        }

        void OnDestroy()
        {
            Client?.Stop();
        }
    }
}
#endif
