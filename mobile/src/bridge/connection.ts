/**
 * The single remote connection this app talks to, plus its bearer tokens.
 *
 * The desktop supports a registry of many sources; the phone has exactly one: the
 * `hermes serve` gateway on the user's PC. Descriptor (URL, username) lives in
 * Preferences; tokens are sealed with {@link SecretBox}.
 */

import type { KeyValueStore, SecretBox } from './storage'

export interface StoredConnection {
  baseUrl: string
  /** Last username used, to pre-fill the connect form. Never the password. */
  username: string
  /** Auth provider name chosen at login (usually "basic"). */
  provider: string
  version?: string
  /**
   * Set when the user accepted plain http:// to a LAN address at login. Holds the exact
   * normalized base URL, so the consent is per server: a different LAN URL asks again.
   */
  lanCleartextAcceptedFor?: string
}

export interface TokenSet {
  accessToken: string
  refreshToken: string
  /** Unix seconds; 0 when the server did not say. */
  expiresAt: number
  provider: string
  userId: string
}

const CONNECTION_KEY = 'hermes.connection.v1'
const TOKENS_KEY = 'hermes.tokens.v1'

type Listener = () => void

export class ConnectionStore {
  private connection: StoredConnection | null | undefined
  private tokens: TokenSet | null | undefined
  private readonly listeners = new Set<Listener>()

  constructor(
    private readonly kv: KeyValueStore,
    private readonly secrets: SecretBox
  ) {}

  onChange(listener: Listener): () => void {
    this.listeners.add(listener)

    return () => void this.listeners.delete(listener)
  }

  private emit() {
    for (const listener of this.listeners) {
      listener()
    }
  }

  async getConnection(): Promise<StoredConnection | null> {
    if (this.connection === undefined) {
      const raw = await this.kv.get(CONNECTION_KEY)

      try {
        this.connection = raw ? (JSON.parse(raw) as StoredConnection) : null
      } catch {
        this.connection = null
      }
    }

    return this.connection
  }

  async setConnection(connection: StoredConnection): Promise<void> {
    this.connection = connection
    await this.kv.set(CONNECTION_KEY, JSON.stringify(connection))
    this.emit()
  }

  async getTokens(): Promise<TokenSet | null> {
    if (this.tokens === undefined) {
      const sealed = await this.kv.get(TOKENS_KEY)
      const raw = sealed ? await this.secrets.open(sealed) : null

      try {
        this.tokens = raw ? (JSON.parse(raw) as TokenSet) : null
      } catch {
        this.tokens = null
      }
    }

    return this.tokens
  }

  async setTokens(tokens: TokenSet | null): Promise<void> {
    this.tokens = tokens

    if (tokens) {
      await this.kv.set(TOKENS_KEY, await this.secrets.seal(JSON.stringify(tokens)))
    } else {
      await this.kv.remove(TOKENS_KEY)
    }

    this.emit()
  }

  /** Forget the session but keep the server URL/username for a quick re-login. */
  async signOut(): Promise<void> {
    await this.setTokens(null)
  }

  /** Forget everything (change server). */
  async clear(): Promise<void> {
    this.connection = null
    await this.kv.remove(CONNECTION_KEY)
    await this.setTokens(null)
  }

  async isSignedIn(): Promise<boolean> {
    return Boolean((await this.getConnection()) && (await this.getTokens())?.accessToken)
  }
}
