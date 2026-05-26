import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface AccountStore {
  readAccounts(): Promise<string>
  writeAccounts(payload: string): Promise<void>
}

export interface KvNamespace {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

export class EnvAccountStore implements AccountStore {
  constructor(private readonly accountsSecret: string | undefined) {}

  async readAccounts(): Promise<string> {
    if (!this.accountsSecret) {
      throw new Error('Missing required env TAYGEDO_ACCOUNTS')
    }
    return this.accountsSecret
  }

  async writeAccounts(): Promise<void> {
    throw new Error('EnvAccountStore is read-only')
  }
}

export class FileAccountStore implements AccountStore {
  constructor(private readonly path: string) {}

  async readAccounts(): Promise<string> {
    return (await readFile(this.path, 'utf8')).trim()
  }

  async writeAccounts(payload: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path, `${payload}\n`, 'utf8')
  }
}

export class GitHubFileAccountStore extends FileAccountStore {}

export class CloudflareKvAccountStore implements AccountStore {
  constructor(
    private readonly kv: KvNamespace,
    private readonly key: string,
    private readonly initialAccounts?: string,
  ) {}

  async readAccounts(): Promise<string> {
    const stored = await this.kv.get(this.key)
    if (stored) {
      return stored
    }
    if (!this.initialAccounts) {
      throw new Error(`Missing accounts in Cloudflare KV key ${this.key}`)
    }
    await this.kv.put(this.key, this.initialAccounts)
    return this.initialAccounts
  }

  async writeAccounts(payload: string): Promise<void> {
    await this.kv.put(this.key, payload)
  }
}

export class UpstashAccountStore implements AccountStore {
  private readonly baseUrl: string

  constructor(
    url: string,
    private readonly token: string,
    private readonly key = 'TAYGEDO_ACCOUNTS',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = url.replace(/\/+$/, '')
  }

  async readAccounts(): Promise<string> {
    const data = await this.request<{ result?: string | null }>(`get/${encodeURIComponent(this.key)}`)
    if (!data.result) {
      throw new Error(`Missing accounts in Upstash key ${this.key}`)
    }
    return data.result
  }

  async writeAccounts(payload: string): Promise<void> {
    await this.request(`set/${encodeURIComponent(this.key)}/${encodeURIComponent(payload)}`)
  }

  private async request<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}/${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    })
    if (!response.ok) {
      throw new Error(`Upstash account request failed: HTTP ${response.status}`)
    }
    return await response.json() as T
  }
}
