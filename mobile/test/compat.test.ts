import { describe, expect, it } from 'vitest'

import {
  assessCompat,
  compatMessage,
  type DismissStore,
  isDismissed,
  parseVersion,
  pendingNotice,
  rememberDismissal
} from '../src/compat'

function memoryStore(initial: Record<string, string> = {}): DismissStore & { data: Record<string, string> } {
  const data = { ...initial }

  return {
    data,
    getItem: key => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value
    }
  }
}

describe('parseVersion', () => {
  it('reads release, prefixed, build-suffixed and pre-release versions', () => {
    expect(parseVersion('0.21.5')).toEqual({ major: 0, minor: 21, patch: 5 })
    expect(parseVersion('v0.21.5')).toEqual({ major: 0, minor: 21, patch: 5 })
    expect(parseVersion('0.21.5+5683.g10c6188')).toEqual({ major: 0, minor: 21, patch: 5 })
    expect(parseVersion('1.2.3-rc.1')).toEqual({ major: 1, minor: 2, patch: 3 })
  })

  it('rejects anything that is not major.minor.patch', () => {
    for (const bad of ['unknown', '', null, undefined, '1.2', '1.2.3.4', 'abc']) {
      expect(parseVersion(bad)).toBeNull()
    }
  })
})

describe('assessCompat (pinned 0.21.5)', () => {
  const pinned = '0.21.5'

  it('stays quiet for the same release and for newer patches', () => {
    expect(assessCompat('0.21.5', pinned)).toBe('compatible')
    expect(assessCompat('0.21.5+1913', pinned)).toBe('compatible')
    expect(assessCompat('0.21.9', pinned)).toBe('compatible')
  })

  it('flags a server that is newer by a minor or major version', () => {
    expect(assessCompat('0.22.0', pinned)).toBe('server-newer')
    expect(assessCompat('0.30.1', pinned)).toBe('server-newer')
    expect(assessCompat('1.0.0', pinned)).toBe('server-newer')
  })

  it('flags an older server (any component)', () => {
    expect(assessCompat('0.21.4', pinned)).toBe('server-older')
    expect(assessCompat('0.20.99', pinned)).toBe('server-older')
    expect(assessCompat('0.9.0', pinned)).toBe('server-older')
  })

  it('compares numerically, not lexically', () => {
    expect(assessCompat('0.100.0', pinned)).toBe('server-newer')
    expect(assessCompat('0.3.0', pinned)).toBe('server-older')
  })

  it('does not guess when a version is missing or unparseable', () => {
    expect(assessCompat(null, pinned)).toBe('unknown')
    expect(assessCompat('unknown', pinned)).toBe('unknown')
    expect(assessCompat('0.21.5', 'garbage')).toBe('unknown')
  })
})

describe('compatMessage', () => {
  it('names both versions and points at a Mono Hermes update when the server is newer', () => {
    const text = compatMessage('server-newer', '0.22.1+17.gabc', '0.21.5')

    expect(text).toContain('v0.22.1')
    expect(text).toContain('v0.21.5')
    expect(text).toContain('Mono Hermes update')
  })

  it('has a message for an older server and none when compatible or unknown', () => {
    expect(compatMessage('server-older', '0.20.0', '0.21.5')).toContain('older')
    expect(compatMessage('compatible', '0.21.5', '0.21.5')).toBeNull()
    expect(compatMessage('unknown', 'x', '0.21.5')).toBeNull()
  })
})

describe('dismissal', () => {
  it('is remembered per server version', () => {
    const store = memoryStore()

    expect(pendingNotice(store, '0.22.0', '0.21.5')).not.toBeNull()

    rememberDismissal(store, '0.22.0', '0.21.5')

    expect(isDismissed(store, '0.22.0', '0.21.5')).toBe(true)
    expect(pendingNotice(store, '0.22.0', '0.21.5')).toBeNull()
    // a different server version is a new situation: show again
    expect(pendingNotice(store, '0.23.0', '0.21.5')).not.toBeNull()
  })

  it('is reset by an app update (new pinned version)', () => {
    const store = memoryStore()
    rememberDismissal(store, '0.22.0', '0.21.5')

    // After the app is updated to a build pinned on 0.22.0 the old dismissal no longer applies,
    // and the same 0.22.0 server is simply compatible.
    expect(pendingNotice(store, '0.22.0', '0.22.0')).toBeNull()
    expect(pendingNotice(store, '0.25.0', '0.22.0')).not.toBeNull()
    expect(isDismissed(store, '0.22.0', '0.22.0')).toBe(false)
  })

  it('survives corrupted or unavailable storage', () => {
    const corrupt = memoryStore({ 'hermes.mobile.compat.dismissed.v1': '{not json' })

    expect(pendingNotice(corrupt, '0.22.0', '0.21.5')).not.toBeNull()

    const broken: DismissStore = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      }
    }

    expect(() => rememberDismissal(broken, '0.22.0', '0.21.5')).not.toThrow()
    expect(pendingNotice(broken, '0.22.0', '0.21.5')).not.toBeNull()
  })

  it('shows nothing without a server version', () => {
    expect(pendingNotice(memoryStore(), null, '0.21.5')).toBeNull()
  })
})
