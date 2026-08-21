using System;

namespace Wardx.Tests
{
    static class Program
    {
        static int Main()
        {
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
