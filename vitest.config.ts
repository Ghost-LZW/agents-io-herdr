import { defineConfig } from "vitest/config";

// Workers: AIO_HERDR_TEST_WORKERS (default 2). The suite opens unix sockets; keep it light.
export default defineConfig({
  test: { testTimeout: 20_000, maxWorkers: Number(process.env.AIO_HERDR_TEST_WORKERS) || 2 },
});
