import fs from 'node:fs'
import path from 'node:path'

export interface TestEnv {
  url: string
  username: string
  password: string
}

/** Reads mobile/.env.test written by the e2e global setup (never printed, never committed). */
export function readTestEnv(): TestEnv {
  const file = path.resolve(import.meta.dirname, '../../.env.test')
  const values: Record<string, string> = {}

  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const eq = line.indexOf('=')

    if (eq > 0) {
      values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
  }

  return {
    password: values.HERMES_TEST_PASSWORD,
    url: values.HERMES_TEST_URL,
    username: values.HERMES_TEST_USERNAME
  }
}
