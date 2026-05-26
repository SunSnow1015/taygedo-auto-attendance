import { loadRuntimeConfig } from './config/runtime.js'
import { TaygedoApi } from './taygedo/api.js'
import { runAttendance, type RunnerDependencies } from './runner.js'
import { GitHubFileAccountStore } from './stores/account-store.js'
import { MemoryStateStore } from './stores/state-store.js'
import { AttendanceService } from './services/attendance-service.js'

interface ActionOptions {
  env?: Record<string, string | undefined>
  api?: RunnerDependencies['api']
}

export async function runAction(options: ActionOptions = {}): Promise<void> {
  const env = options.env ?? process.env
  const config = loadRuntimeConfig(env)
  const service = new AttendanceService({
    accountStore: {
      readAccounts: async () => {
        if (!config.accountsSecret) {
          throw new Error('Missing required env TAYGEDO_ACCOUNTS')
        }
        return config.accountsSecret
      },
      writeAccounts: payload => new GitHubFileAccountStore(config.updatedAccountsPath).writeAccounts(payload),
    },
    stateStore: new MemoryStateStore(config.statePrefix),
    api: options.api ?? new TaygedoApi(),
    accountPasswords: config.accountPasswords,
    credentialKey: config.credentialKey,
    notificationUrls: config.notificationUrls,
    maxRetries: config.maxRetries,
    forceRun: config.forceRun,
  })
  await service.run()

  console.log(`Updated accounts written to ${config.updatedAccountsPath}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAction().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
