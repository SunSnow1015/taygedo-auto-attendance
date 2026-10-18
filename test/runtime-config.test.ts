import { describe, expect, it } from 'vitest'
import { loadRuntimeConfig } from '../src/config/runtime.js'

describe('loadRuntimeConfig', () => {
  it('loads defaults and notification urls from env', () => {
    expect(loadRuntimeConfig({
      TAYGEDO_ACCOUNTS: '[{"id":"main"}]',
      TAYGEDO_NOTIFICATION_URLS: ' https://example.com/a,https://example.com/b ',
      TAYGEDO_SERVERCHAN_SENDKEY: ' SCT123 ',
    })).toEqual(expect.objectContaining({
      accountsSecret: '[{"id":"main"}]',
      notificationUrls: [
        'https://example.com/a',
        'https://example.com/b',
        'https://sctapi.ftqq.com/SCT123.send',
      ],
      maxRetries: 3,
      accountConcurrency: 1,
      updatedAccountsPath: 'updated-accounts.json',
      accountStore: 'env',
      stateStore: 'memory',
      accountsKey: 'TAYGEDO_ACCOUNTS',
      statePrefix: 'taygedo',
      accountPasswords: {},
      forceRun: false,
      coinTasks: true,
      cloudDuration: true,
      sharePlatform: 'qq',
      loopSeconds: undefined,
    }))
  })

  it('uses the default retry count when the env value is blank', () => {
    expect(loadRuntimeConfig({
      TAYGEDO_MAX_RETRIES: '',
    })).toEqual(expect.objectContaining({
      maxRetries: 3,
    }))
  })

  it('treats blank optional workflow values as unset', () => {
    expect(loadRuntimeConfig({
      TAYGEDO_NOTIFICATION_URLS: '',
      TAYGEDO_SERVERCHAN_SENDKEY: '',
      TAYGEDO_MAX_RETRIES: '',
      TAYGEDO_PASSWORDS: '',
      TAYGEDO_LOGIN_PASSWORD: '',
      TAYGEDO_CREDENTIAL_KEY: '',
      TAYGEDO_COIN_TASKS: '',
      TAYGEDO_CLOUD_DURATION: '',
      TAYGEDO_SHARE_PLATFORM: '',
      TAYGEDO_LOOP_SECONDS: '',
      TAYGEDO_UPSTASH_REDIS_REST_URL: '',
      TAYGEDO_UPSTASH_REDIS_REST_TOKEN: '',
    })).toEqual(expect.objectContaining({
      notificationUrls: [],
      maxRetries: 3,
      accountPasswords: {},
      credentialKey: undefined,
      coinTasks: true,
      cloudDuration: true,
      sharePlatform: 'qq',
      loopSeconds: undefined,
      upstashUrl: undefined,
      upstashToken: undefined,
    }))
  })

  it('loads coin task and cloud duration options from env', () => {
    expect(loadRuntimeConfig({
      TAYGEDO_COIN_TASKS: 'false',
      TAYGEDO_CLOUD_DURATION: 'false',
      TAYGEDO_SHARE_PLATFORM: 'wb',
    })).toEqual(expect.objectContaining({
      coinTasks: false,
      cloudDuration: false,
      sharePlatform: 'wb',
    }))
  })

  it('loads account concurrency from env', () => {
    expect(loadRuntimeConfig({ TAYGEDO_ACCOUNT_CONCURRENCY: '2' })).toEqual(expect.objectContaining({
      accountConcurrency: 2,
    }))
  })

  it('loads docker loop seconds from env', () => {
    expect(loadRuntimeConfig({ TAYGEDO_LOOP_SECONDS: '86400' })).toEqual(expect.objectContaining({
      loopSeconds: 86400,
    }))
  })

  it('loads the daily run time from env', () => {
    expect(loadRuntimeConfig({ TAYGEDO_RUN_AT: '9:30' })).toEqual(expect.objectContaining({
      dailyAt: { hour: 9, minute: 30 },
    }))
    expect(loadRuntimeConfig({ TAYGEDO_RUN_AT: ' 09:30 ' })).toEqual(expect.objectContaining({
      dailyAt: { hour: 9, minute: 30 },
    }))
    expect(loadRuntimeConfig({ TAYGEDO_RUN_AT: '00:00' })).toEqual(expect.objectContaining({
      dailyAt: { hour: 0, minute: 0 },
    }))
    expect(loadRuntimeConfig({ TAYGEDO_RUN_AT: '23:59' })).toEqual(expect.objectContaining({
      dailyAt: { hour: 23, minute: 59 },
    }))
    expect(loadRuntimeConfig({ TAYGEDO_RUN_AT: '' })).toEqual(expect.objectContaining({
      dailyAt: undefined,
    }))
  })

  it('rejects invalid daily run times', () => {
    expect(() => loadRuntimeConfig({ TAYGEDO_RUN_AT: '24:00' })).toThrow('TAYGEDO_RUN_AT')
    expect(() => loadRuntimeConfig({ TAYGEDO_RUN_AT: '9:60' })).toThrow('TAYGEDO_RUN_AT')
    expect(() => loadRuntimeConfig({ TAYGEDO_RUN_AT: 'morning' })).toThrow('TAYGEDO_RUN_AT')
    expect(() => loadRuntimeConfig({ TAYGEDO_RUN_AT: '9:3' })).toThrow('TAYGEDO_RUN_AT')
  })

  it('loads the force run flag from env', () => {
    expect(loadRuntimeConfig({ TAYGEDO_FORCE_RUN: 'true' })).toEqual(expect.objectContaining({
      forceRun: true,
    }))
    expect(loadRuntimeConfig({ TAYGEDO_FORCE_RUN: '1' })).toEqual(expect.objectContaining({
      forceRun: true,
    }))
  })

  it('loads account passwords from a json map and default password env', () => {
    expect(loadRuntimeConfig({
      TAYGEDO_PASSWORDS: '{"main":"main-password","13800138000":"phone-password"}',
      TAYGEDO_LOGIN_PASSWORD: 'default-password',
      TAYGEDO_LOGIN_ACCOUNT_ID: 'alt',
      TAYGEDO_CREDENTIAL_KEY: 'credential-key',
    })).toEqual(expect.objectContaining({
      credentialKey: 'credential-key',
      accountPasswords: {
        main: 'main-password',
        '13800138000': 'phone-password',
        default: 'default-password',
        alt: 'default-password',
      },
    }))
  })

  it('loads storage settings and admin token', () => {
    expect(loadRuntimeConfig({
      TAYGEDO_MAX_RETRIES: '5',
      TAYGEDO_UPDATED_ACCOUNTS_PATH: 'out/accounts.json',
      TAYGEDO_ACCOUNT_STORE: 'cloudflare-kv',
      TAYGEDO_STATE_STORE: 'upstash',
      TAYGEDO_ACCOUNTS_KEY: 'accounts',
      TAYGEDO_STATE_PREFIX: 'prod',
      TAYGEDO_ADMIN_TOKEN: 'admin-token',
      TAYGEDO_UPSTASH_REDIS_REST_URL: 'https://redis.example.com',
      TAYGEDO_UPSTASH_REDIS_REST_TOKEN: 'redis-token',
    })).toEqual(expect.objectContaining({
      accountsSecret: undefined,
      maxRetries: 5,
      updatedAccountsPath: 'out/accounts.json',
      accountStore: 'cloudflare-kv',
      stateStore: 'upstash',
      accountsKey: 'accounts',
      statePrefix: 'prod',
      adminToken: 'admin-token',
      upstashUrl: 'https://redis.example.com',
      upstashToken: 'redis-token',
    }))
  })

  it('accepts unstorage store kinds', () => {
    expect(loadRuntimeConfig({
      TAYGEDO_ACCOUNT_STORE: 'unstorage',
      TAYGEDO_STATE_STORE: 'unstorage',
    })).toEqual(expect.objectContaining({
      accountStore: 'unstorage',
      stateStore: 'unstorage',
    }))
  })

  it('rejects invalid retry values', () => {
    expect(() => loadRuntimeConfig({ TAYGEDO_MAX_RETRIES: 'nope' })).toThrow('TAYGEDO_MAX_RETRIES 必须是正整数')
  })

  it('rejects invalid account concurrency values', () => {
    expect(() => loadRuntimeConfig({ TAYGEDO_ACCOUNT_CONCURRENCY: '0' })).toThrow('TAYGEDO_ACCOUNT_CONCURRENCY 必须是正整数')
  })
})
