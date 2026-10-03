/**
 * Persistence primitives.
 *
 * - {@link KeyValueStore}: plain string storage (Capacitor Preferences on device,
 *   an in-memory map in tests).
 * - {@link createSecretBox}: protects the bearer/refresh tokens. The AES-GCM key
 *   is generated as a NON-EXTRACTABLE WebCrypto key and kept in IndexedDB, so the
 *   ciphertext in Preferences is useless without the app's own key handle (JS can
 *   use the key but never read it). It is "secure-ish": it defeats casual
 *   inspection of the Preferences file / adb backups, not a rooted attacker with
 *   code execution inside the app. Android backup is disabled in the manifest.
 */

export interface KeyValueStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

export interface SecretBox {
  seal(plaintext: string): Promise<string>
  open(sealed: string): Promise<string | null>
}

export function createMemoryStore(): KeyValueStore {
  const map = new Map<string, string>()

  return {
    get: async key => map.get(key) ?? null,
    remove: async key => void map.delete(key),
    set: async (key, value) => void map.set(key, value)
  }
}

export function createPreferencesStore(): KeyValueStore {
  // Capacitor plugins are Proxy objects that answer `then` with a "not implemented" error, so a plugin
  // must never be returned from an async function (the await would try to unwrap it as a thenable).
  // Wrapping it in a plain object keeps it safe.
  const load = async () => ({ plugin: (await import('@capacitor/preferences')).Preferences })

  return {
    async get(key) {
      return (await (await load()).plugin.get({ key })).value
    },
    async remove(key) {
      await (await load()).plugin.remove({ key })
    },
    async set(key, value) {
      await (await load()).plugin.set({ key, value })
    }
  }
}

export function createLocalStorageStore(): KeyValueStore {
  return {
    get: async key => localStorage.getItem(key),
    remove: async key => void localStorage.removeItem(key),
    set: async (key, value) => void localStorage.setItem(key, value)
  }
}

const KEY_DB = 'hermes-mobile-keys'
const KEY_STORE = 'keys'
const KEY_ID = 'token-box-v1'

function openKeyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(KEY_DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(KEY_STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function idb<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = run(db.transaction(KEY_STORE, mode).objectStore(KEY_STORE))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const fromBase64 = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0))

/** Encrypt-at-rest box using a non-extractable AES-GCM key persisted in IndexedDB. */
export function createSecretBox(): SecretBox {
  let keyPromise: Promise<CryptoKey> | null = null

  const loadKey = () => {
    keyPromise ??= (async () => {
      const db = await openKeyDb()
      const existing = await idb<CryptoKey | undefined>(db, 'readonly', store => store.get(KEY_ID))

      if (existing) {
        return existing
      }

      const created = await crypto.subtle.generateKey({ length: 256, name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
      await idb(db, 'readwrite', store => store.put(created, KEY_ID))

      return created
    })()

    return keyPromise
  }

  return {
    async open(sealed) {
      try {
        const raw = fromBase64(sealed)
        const plain = await crypto.subtle.decrypt(
          { iv: raw.slice(0, 12), name: 'AES-GCM' },
          await loadKey(),
          raw.slice(12)
        )

        return new TextDecoder().decode(plain)
      } catch {
        // Key lost (app data cleared) or ciphertext corrupt: behave as "no secret".
        return null
      }
    },
    async seal(plaintext) {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const cipher = await crypto.subtle.encrypt(
        { iv, name: 'AES-GCM' },
        await loadKey(),
        new TextEncoder().encode(plaintext)
      )

      const out = new Uint8Array(iv.length + cipher.byteLength)
      out.set(iv, 0)
      out.set(new Uint8Array(cipher), iv.length)

      return toBase64(out)
    }
  }
}

/** Test/fallback box: identity transform. Never used on device. */
export function createPlainSecretBox(): SecretBox {
  return { open: async sealed => sealed, seal: async plaintext => plaintext }
}
