using System;
using System.Threading;

namespace Wardx.Tests
{
    static class Program
    {
        static int Main(string[] args)
        {
            if (args.Length > 0 && args[0] == "interop") return RunInterop(args);
            var failed = 0;
            failed += Run("hash", HashTests.Run);
            failed += Run("experiments", ExperimentTests.Run);
            failed += Run("metrics", MetricsTests.Run);
            failed += Run("buffers", BufferTests.Run);
            failed += Run("frames", FrameTests.Run);
            failed += Run("settings", SettingsTests.Run);
            failed += Run("json", JsonTests.Run);
            failed += Run("sync", SyncTests.Run);
            if (failed == 0) Console.WriteLine("all tests passed");
            else Console.WriteLine(failed + " group(s) failed");
            return failed == 0 ? 0 : 1;
        }

        static int RunInterop(string[] args)
        {
            if (args.Length != 2)
            {
                Console.Error.WriteLine("usage: Wardx.Tests interop <endpoint>");
                return 2;
            }
            WardxClient client = null;
            try
            {
                client = WardxClient.Create(new WardxOptions
                {
                    Endpoint = args[1],
                    ProjectKey = "black-box-key",
                    Project = "demo",
                    Role = "csharp",
                    AppVersion = "1.0.0",
                    Environment = "test",
                    PrivacySalt = "black-box-privacy-salt",
                    AggregateIntervalMs = 60_000,
                    SyncIntervalMs = 60_000,
                    HttpTimeoutMs = 2_000
                });
                var remote = "missing";
                for (var attempt = 0; attempt < 200; attempt++)
                {
                    remote = client.Config.Get("interop.remote", "missing", "interop-subject");
                    if (remote == "experiment") break;
                    Thread.Sleep(25);
                }
                if (remote != "experiment")
                {
                    throw new InvalidOperationException(
                        "interop.remote expected experiment, got " + remote
                    );
                }
                var hidden = client.Config.Get("interop.hidden", "hidden", "interop-subject");
                if (hidden != "hidden")
                {
                    throw new InvalidOperationException(
                        "interop.hidden must remain role-filtered, got " + hidden
                    );
                }
                client.Counter("interop.counter", Dims.Of("runtime", "csharp")).Inc();
                client.Event("interop.event", Dims.Of("runtime", "csharp"));
                client.Experiment.Goal("interop.goal", "interop-subject", 2);
                client.ShutdownAsync().GetAwaiter().GetResult();
                Console.WriteLine("{\"ok\":true,\"remote\":\"experiment\"}");
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine(ex);
                if (client != null)
                {
                    try { client.ShutdownAsync().GetAwaiter().GetResult(); }
                    catch { }
                }
                return 1;
            }
        }

        static int Run(string name, Action test)
        {
            try
            {
                test();
                Console.WriteLine("ok    " + name);
                return 0;
            }
            catch (Exception ex)
            {
                Console.WriteLine("FAIL  " + name);
                Console.WriteLine("      " + ex);
                return 1;
            }
        }
    }
}
