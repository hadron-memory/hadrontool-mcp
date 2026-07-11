import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      MCP_TOOL_TOKEN: 'test-tool-token',
      // The test fixture upstream listens on 127.0.0.1, which the SSRF
      // guard would otherwise block; the guard's own test flips this off.
      MCP_ALLOW_PRIVATE_NETWORKS: 'true',
    },
    fileParallelism: false,
  },
});
