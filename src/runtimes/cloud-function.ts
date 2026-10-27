import { loadRuntimeConfig } from '../config/runtime.js'
import { AttendanceService } from '../services/attendance-service.js'
import { UpstashAccountStore } from '../stores/account-store.js'
import { UpstashStateStore } from '../stores/state-store.js'
import { TaygedoApi } from '../taygedo/api.js'

export interface CloudFunctionResult {
  ok: boolean
  summary: string
  successCount: number
  failedCount: number
  skippedCount: number
}

interface CloudFunctionOptions {
  env?: Record<string, string | undefined>
  api?: ConstructorParameters<typeof AttendanceService>[0]['api']
  fetch?: typeof globalThis.fetch
}

interface CloudFunctionContext extends Record<string, unknown> {
  TAYGEDO_TEST_API?: ConstructorParameters<typeof AttendanceService>[0]['api']
}

export async function main_handler(event: unknown, context: unknown): Promise<CloudFunctionResult> {
  console.log(`云函数触发事件：${summarizeEvent(event)}`)
  try {
    return await runScheduledCloudFunction({
      api: readTestApi(context),
    })
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    throw error
  }
}

export const handler = main_handler

export async function runScheduledCloudFunction(options: CloudFunctionOptions = {}): Promise<CloudFunctionResult> {
  const env = forceUpstashEnv(options.env ?? process.env)
  const config = loadRuntimeConfig(env)
  if (!config.upstashUrl || !config.upstashToken) {
    throw new Error('云函数部署必须配置 TAYGEDO_UPSTASH_REDIS_REST_URL 和 TAYGEDO_UPSTASH_REDIS_REST_TOKEN')
  }
  if (!config.credentialKey) {
    throw new Error('云函数部署必须配置 TAYGEDO_CREDENTIAL_KEY')
  }
  const service = new AttendanceService({
    accountStore: new UpstashAccountStore(config.upstashUrl, config.upstashToken, config.accountsKey, options.fetch, config.accountsSecret),
    stateStore: new UpstashStateStore(config.upstashUrl, config.upstashToken, config.statePrefix, options.fetch),
    api: options.api ?? new TaygedoApi(),
    accountPasswords: config.accountPasswords,
    credentialKey: config.credentialKey,
    notificationUrls: config.notificationUrls,
    maxRetries: config.maxRetries,
    accountConcurrency: config.accountConcurrency,
    forceRun: config.forceRun,
    coinTasks: config.coinTasks,
    cloudDuration: config.cloudDuration,
    sharePlatform: config.sharePlatform,
  })
  const result = await service.run()
  return {
    ok: true,
    summary: result.summary,
    successCount: result.successCount,
    failedCount: result.failedCount,
    skippedCount: result.skippedCount,
  }
}

function forceUpstashEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    ...env,
    TAYGEDO_ACCOUNT_STORE: 'upstash',
    TAYGEDO_STATE_STORE: 'upstash',
  }
}

function readTestApi(context: unknown): CloudFunctionOptions['api'] | undefined {
  if (typeof context !== 'object' || context === null || Array.isArray(context)) {
    return undefined
  }
  return (context as CloudFunctionContext).TAYGEDO_TEST_API
}

function summarizeEvent(event: unknown): string {
  if (Buffer.isBuffer(event)) {
    return `buffer:${event.length}`
  }
  if (typeof event === 'object' && event !== null) {
    const record = event as Record<string, unknown>
    const type = typeof record.Type === 'string' ? record.Type : undefined
    const triggerName = typeof record.TriggerName === 'string'
      ? record.TriggerName
      : typeof record.triggerName === 'string'
        ? record.triggerName
        : undefined
    return JSON.stringify({ type, triggerName })
  }
  return typeof event
}
