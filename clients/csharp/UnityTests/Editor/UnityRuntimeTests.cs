using System;
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

        sealed class CaptureTransport : ISyncTransport
        {
            public string Json;

            public Task<SyncResult> PostAsync(byte[] body, CancellationToken token)
            {
                using (var input = new MemoryStream(body))
                using (var gzip = new GZipStream(input, CompressionMode.Decompress))
                using (var reader = new StreamReader(gzip)) Json = reader.ReadToEnd();
                return Task.FromResult(new SyncResult(true, 200, "{}"));
            }

            public void Close() { }
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
            var capture = new CaptureTransport();
            using (var client = WardxClient.Create(Options("http://127.0.0.1:9"), capture))
            {
                client.RetentionActivity("test-user");
                await Within(client.FlushAsync());
                Require(capture.Json.Contains("\"name\":\"wardx-unity\""), "Unity SDK identity");
                Require(capture.Json.Contains("\"platform\":\"unity\""), "Unity platform identity");
            }

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
