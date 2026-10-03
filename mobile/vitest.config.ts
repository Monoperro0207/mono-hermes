import path from 'node:path'

import { defineConfig } from 'vitest/config'

import { buildConstants } from './build-constants.ts'

const desktop = path.resolve(import.meta.dirname, '../upstream/apps/desktop')
const shared = path.resolve(import.meta.dirname, '../upstream/apps/shared/src')

// Unit tests: pure bridge logic, no server, no DOM.
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
    exclude: ['test/e2e/**'],
    include: ['test/**/*.test.ts']
  }
})
