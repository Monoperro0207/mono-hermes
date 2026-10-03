import path from 'node:path'

import { startThrowawayServer, type ThrowawayServer } from '../support/throwaway-server'

let server: ThrowawayServer | null = null

export async function setup() {
  // Credentials are generated per run and only land in the gitignored mobile/.env.test.
  server = await startThrowawayServer({ envFile: path.resolve(import.meta.dirname, '../../.env.test') })
}

export async function teardown() {
  await server?.stop()
  server = null
}
