import path from 'node:path'

import { defineConfig } from 'vitest/config'

import { buildConstants } from './build-constants.ts'

const desktop = path.resolve(import.meta.dirname, '../upstream/apps/desktop')
const shared = path.resolve(import.meta.dirname, '../upstream/apps/shared/src')

// End-to-end: spins up a throwaway isolated `hermes serve` (see test/support/throwaway-server.ts)
// and drives the real bridge code against it over HTTP + WebSocket.
export default defineConfig({
  define: buildConstants(),
  resolve: {
    alias: {
      '@': path.join(desktop, 'src'),
      '@hermes/shared': shared
    }
  },
  test: {
    environment: 'node',
    fileParallelism: false,
    globalSetup: ['test/e2e/global-setup.ts'],
    hookTimeout: 30 * 60_000,
    include: ['test/e2e/**/*.e2e.test.ts'],
    testTimeout: 60_000
  }
})
