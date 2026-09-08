#if UNITY_5_3_OR_NEWER
using System;
using System.Collections;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;
using UnityEngine.Networking;
using UnityEngine.Profiling;

namespace Wardx
{
    public sealed class UnityWebRequestTransport : ISyncTransport
    {
        readonly SynchronizationContext _context;
        readonly int _threadId;
        readonly HashSet<PendingRequest> _pending = new HashSet<PendingRequest>();
        readonly string _url;
        readonly string _projectKey;
        readonly int _timeoutSeconds;
        int _closed;

        sealed class PendingRequest
        {
            public readonly TaskCompletionSource<SyncResult> Completion = new TaskCompletionSource<SyncResult>(TaskCreationOptions.RunContinuationsAsynchronously);
            public UnityWebRequest Request;
            public CancellationTokenRegistration Cancellation;
        }

        public UnityWebRequestTransport(MonoBehaviour runner, string endpoint, string projectKey, int httpTimeoutMs)
        {
            if (runner == null) throw new ArgumentNullException(nameof(runner));
            _context = SynchronizationContext.Current ?? throw new InvalidOperationException("Create the Unity transport on the Unity main thread.");
            _threadId = Thread.CurrentThread.ManagedThreadId;
            _url = SyncUrl(endpoint);
            _projectKey = projectKey;
            _timeoutSeconds = Math.Max(1, (httpTimeoutMs + 999) / 1000);
        }

        public Task<SyncResult> PostAsync(byte[] gzippedBody, CancellationToken cancellationToken)
        {
            var pending = new PendingRequest();
            OnMainThread(() => Post(gzippedBody, pending, cancellationToken));
            return pending.Completion.Task;
        }

        public void Close()
        {
            if (Interlocked.Exchange(ref _closed, 1) != 0) return;
            OnMainThread(() =>
            {
                foreach (var pending in new List<PendingRequest>(_pending)) Cancel(pending);
            });
        }

        void OnMainThread(Action action)
        {
            if (Thread.CurrentThread.ManagedThreadId == _threadId) action();
            else _context.Post(_ => action(), null);
        }

        void Post(byte[] body, PendingRequest pending, CancellationToken cancellationToken)
        {
            if (Volatile.Read(ref _closed) != 0 || cancellationToken.IsCancellationRequested)
            {
                pending.Completion.TrySetCanceled();
                return;
            }
            _pending.Add(pending);
            try
            {
                var request = pending.Request = new UnityWebRequest(_url, UnityWebRequest.kHttpVerbPOST);
                request.uploadHandler = new UploadHandlerRaw(body);
                request.downloadHandler = new DownloadHandlerBuffer();
                request.SetRequestHeader("Content-Type", "application/json");
                request.SetRequestHeader("Content-Encoding", "gzip");
                request.SetRequestHeader("X-Wardx-Key", _projectKey);
                request.SetRequestHeader("Accept", "application/json");
                request.timeout = _timeoutSeconds;
                pending.Cancellation = cancellationToken.Register(() => _context.Post(_ => Cancel(pending), null));
                request.SendWebRequest().completed += _ => Complete(pending);
            }
            catch (Exception error)
            {
                Release(pending);
                pending.Completion.TrySetException(error);
            }
        }

        void Complete(PendingRequest pending)
        {
            if (!_pending.Contains(pending)) return;
            try
            {
                var request = pending.Request;
                var status = (int)request.responseCode;
                var text = request.downloadHandler != null ? request.downloadHandler.text : "";
                var result = new SyncResult(status >= 200 && status < 300, status, text);
                Release(pending);
                pending.Completion.TrySetResult(result);
            }
            catch (Exception error)
            {
                Release(pending);
                pending.Completion.TrySetException(error);
            }
        }

        void Cancel(PendingRequest pending)
        {
            if (!_pending.Remove(pending)) return;
            try { pending.Request?.Abort(); }
            finally
            {
                Release(pending);
                pending.Completion.TrySetCanceled();
            }
        }

        void Release(PendingRequest pending)
        {
            _pending.Remove(pending);
            pending.Cancellation.Dispose();
            pending.Request?.Dispose();
            pending.Request = null;
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

        void OnDestroy()
        {
            _client?.Stop();
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
                PrivacySalt = privacySalt
            }));
        }

        void OnDestroy()
        {
            Client?.Stop();
        }
    }
}
#endif
