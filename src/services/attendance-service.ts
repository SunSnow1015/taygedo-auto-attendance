import { TaygedoApi } from '../taygedo/api.js'
import { runAttendance, type RunnerDependencies } from '../runner.js'
import type { AccountStore } from '../stores/account-store.js'
import type { StateStore } from '../stores/state-store.js'

export interface AttendanceServiceOptions {
  accountStore: AccountStore
  stateStore?: StateStore
  api?: RunnerDependencies['api']
  accountPasswords?: Record<string, string>
  credentialKey?: string
  notificationUrls?: string[]
  maxRetries?: number
  forceRun?: boolean
}

export class AttendanceService {
  constructor(private readonly options: AttendanceServiceOptions) {}

  async run(): Promise<Awaited<ReturnType<typeof runAttendance>>> {
    const accountsSecret = await this.options.accountStore.readAccounts()
    const result = await runAttendance({
      accountsSecret,
      api: this.options.api ?? new TaygedoApi(),
      accountPasswords: this.options.accountPasswords,
      credentialKey: this.options.credentialKey,
      notificationUrls: this.options.notificationUrls,
      maxRetries: this.options.maxRetries,
      stateStore: this.options.stateStore,
      forceRun: this.options.forceRun,
      secretWriter: payload => this.options.accountStore.writeAccounts(payload),
    })
    return result
  }
}
