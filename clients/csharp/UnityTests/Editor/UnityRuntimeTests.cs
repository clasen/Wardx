using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;

namespace Wardx.Tests
{
    sealed class UnityTransportTestRunner : MonoBehaviour { }

    public static class UnityRuntimeTests
    {
        sealed class LocalServer : TcpListener, IDisposable
        {
            public LocalServer() : base(IPAddress.Loopback, 0) { Start(); }
            public void Dispose() { Stop(); }
        }

        sealed class ThreadObservedAttributes : IReadOnlyDictionary<string, object>
        {
            readonly Dictionary<string, object> _values = new Dictionary<string, object> { ["lane"] = "東京" };
            public int LastThreadId;
            public int Count => _values.Count;
            public IEnumerable<string> Keys => _values.Keys;
            public IEnumerable<object> Values => _values.Values;
            public object this[string key] => _values[key];
            public bool ContainsKey(string key) => _values.ContainsKey(key);
            public bool TryGetValue(string key, out object value) => _values.TryGetValue(key, out value);
            public IEnumerator<KeyValuePair<string, object>> GetEnumerator()
            {
                LastThreadId = Thread.CurrentThread.ManagedThreadId;
                return _values.GetEnumerator();
            }
            System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
        }

        sealed class CaptureTransport : ISyncTransport
        {
            public string Json;
            public string SecondJson;
            public int PostCount;
            public int CloseCount;
            public readonly TaskCompletionSource<bool> Started = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            public TaskCompletionSource<bool> Release;

            public async Task<SyncResult> PostAsync(byte[] body, CancellationToken token)
            {
                using (var input = new MemoryStream(body))
                using (var gzip = new GZipStream(input, CompressionMode.Decompress))
                using (var reader = new StreamReader(gzip)) Json = reader.ReadToEnd();
                PostCount++;
                if (PostCount == 2) SecondJson = Json;
                Started.TrySetResult(true);
                if (PostCount == 1 && Release != null) await Release.Task.ConfigureAwait(false);
                return new SyncResult(true, 200, "{}");
            }

            public void Close() { CloseCount++; }
        }

        public static async void Run()
        {
            var exitCode = 1;
            try
            {
                var playing = new TaskCompletionSource<bool>();
                void EnteredPlayMode(PlayModeStateChange state)
                {
                    if (state != PlayModeStateChange.EnteredPlayMode) return;
                    EditorApplication.playModeStateChanged -= EnteredPlayMode;
                    playing.SetResult(true);
                }
                EditorSettings.enterPlayModeOptionsEnabled = true;
                EditorSettings.enterPlayModeOptions = EnterPlayModeOptions.DisableDomainReload | EnterPlayModeOptions.DisableSceneReload;
                EditorApplication.playModeStateChanged += EnteredPlayMode;
                EditorApplication.EnterPlaymode();
                await playing.Task;
                await CheckRuntime();
                await CheckTransport();
                Debug.Log("Wardx Unity runtime tests passed");
                exitCode = 0;
            }
            catch (Exception error) { Debug.LogException(error); }
            finally { EditorApplication.Exit(exitCode); }
        }

        static WardxOptions Options(string endpoint)
        {
            return new WardxOptions
            {
                Endpoint = endpoint,
                ProjectKey = "test-key",
                Project = "test",
                Role = "unity",
                AppVersion = "1.0.0",
                Environment = "test",
                PrivacySalt = "test-salt",
                HttpTimeoutMs = 30_000
            };
        }

        static async Task CheckRuntime()
        {
            var mainThread = Thread.CurrentThread.ManagedThreadId;
            var capture = new CaptureTransport();
            using (var client = WardxClient.Create(Options("http://127.0.0.1:9"), capture))
            {
                client.RetentionActivity("test-user");
                var attributes = new ThreadObservedAttributes();
                client.Event("thread.probe", attributes);
                await Within(client.FlushAsync());
                Require(capture.Json.Contains("\"name\":\"wardx-unity\""), "Unity SDK identity");
                Require(capture.Json.Contains("\"platform\":\"unity\""), "Unity platform identity");
                Require(attributes.LastThreadId != mainThread, "envelope encoding runs off the Unity main thread");
            }
            await CheckCoalescing();

            using (var server = new LocalServer())
            {
                var client = WardxClient.Create(Options(Endpoint(server)));
                var host = GameObject.Find("Wardx");
                Require(host != null, "factory creates the Unity host");
                try
                {
                    client.Counter("test.counter").Inc();
                    var flush = client.FlushAsync();
                    using (var connection = await Within(server.AcceptTcpClientAsync()))
                    {
                        UnityEngine.Object.DestroyImmediate(host);
                        await Within(flush);
                        client.Stop();
                    }
                }
                finally
                {
                    client.Stop();
                    if (host != null) UnityEngine.Object.DestroyImmediate(host);
                }
            }
        }

        static async Task CheckCoalescing()
        {
            var capture = new CaptureTransport
            {
                Release = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously)
            };
            using (var client = WardxClient.Create(Options("http://127.0.0.1:9"), capture))
            {
                try
                {
                    var first = client.FlushAsync();
                    await Within(capture.Started.Task);
                    var pending = client.FlushAsync();
                    var counter = client.Counter("operations");
                    for (var i = 0; i < 10000; i++)
                    {
                        counter.Inc();
                        Require(ReferenceEquals(pending, client.FlushAsync()), "one pending flush task");
                    }
                    await Task.Yield();
                    Require(capture.PostCount == 1, "one active send while Unity continues updating");
                    var shutdown = client.ShutdownAsync();
                    Require(ReferenceEquals(shutdown, client.ShutdownAsync()), "shutdown shares its final flush");
                    capture.Release.TrySetResult(true);
                    await Within(Task.WhenAll(first, pending, shutdown));
                    Require(capture.PostCount == 3, "active, coalesced and final sync only");
                    Require(capture.SecondJson.Contains("[\"operations\",null,10000]"), "all observations preserved");
                    Require(capture.CloseCount == 1, "transport closed once after drain");
                }
                finally { capture.Release.TrySetResult(true); }
            }
        }

        static async Task CheckTransport()
        {
            var host = new GameObject("Wardx transport test");
            var runner = host.AddComponent<UnityTransportTestRunner>();
            using (var server = new LocalServer())
            {
                var transport = new UnityWebRequestTransport(runner, Endpoint(server), "test-key", 30_000);
                try
                {
                    using (var canceled = new CancellationTokenSource())
                    {
                        canceled.Cancel();
                        await Canceled(transport.PostAsync(new byte[0], canceled.Token));
                    }

                    using (var timeout = new CancellationTokenSource())
                    {
                        var pending = transport.PostAsync(new byte[0], timeout.Token);
                        using (var connection = await Within(server.AcceptTcpClientAsync()))
                        {
                            runner.StopAllCoroutines();
                            await Task.Run(() => timeout.Cancel());
                            await Canceled(pending);
                        }
                    }

                    var success = Task.Run(() => transport.PostAsync(new byte[0], CancellationToken.None));
                    using (var connection = await Within(server.AcceptTcpClientAsync()))
                    {
                        var response = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
                        await connection.GetStream().WriteAsync(response, 0, response.Length);
                        var result = await Within(success);
                        Require(result.Ok && result.Status == 200 && result.Text == "{}", "successful request after cancellation");
                    }

                    var first = transport.PostAsync(new byte[0], CancellationToken.None);
                    var second = transport.PostAsync(new byte[0], CancellationToken.None);
                    using (var connection = await Within(server.AcceptTcpClientAsync()))
                    {
                        runner.StopAllCoroutines();
                        transport.Close();
                        Require(first.IsCanceled && second.IsCanceled, "Close settles all active requests synchronously on the main thread");
                        transport.Close();
                        await Canceled(transport.PostAsync(new byte[0], CancellationToken.None));
                    }
                }
                finally
                {
                    transport.Close();
                    UnityEngine.Object.DestroyImmediate(host);
                }
            }
        }

        static string Endpoint(TcpListener server) => "http://127.0.0.1:" + ((IPEndPoint)server.LocalEndpoint).Port;

        static async Task Canceled(Task task)
        {
            try { await Within(task); }
            catch (OperationCanceledException) { return; }
            throw new Exception("Expected cancellation");
        }

        static async Task Within(Task task)
        {
            Require(await Task.WhenAny(task, Task.Delay(5_000)) == task, "operation completes before the HTTP timeout");
            await task;
        }

        static async Task<T> Within<T>(Task<T> task)
        {
            await Within((Task)task);
            return await task;
        }

        static void Require(bool condition, string message)
        {
            if (!condition) throw new Exception(message);
        }
    }
}
