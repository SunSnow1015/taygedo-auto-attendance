import { loadRuntimeConfig } from '../config/runtime.js'
import { AttendanceService } from '../services/attendance-service.js'
import { LoginService, type LoginServiceRunOptions } from '../services/login-service.js'
import { createAccountStore, createStateStore } from '../stores/factory.js'
import { loadOrCreateCredentialKey } from '../config/credentials.js'

interface LocalCliDependencies {
  service?: LocalCliService
}

interface LocalCliService {
  runAttendance(options: { accountsFile: string, stateDir?: string, forceRun?: boolean }): Promise<unknown>
  runLogin(options: LoginServiceRunOptions): Promise<unknown>
  sendLoginCode(options: LoginServiceRunOptions): Promise<unknown>
}

export async function runLocalCli(argv = process.argv.slice(2), deps: LocalCliDependencies = {}): Promise<void> {
  const command = argv[0]
  const options = parseArgs(argv.slice(1))
  const service: LocalCliService = deps.service ?? createDefaultService()

  if (command === 'attendance') {
    const accountsFile = options['accounts-file']
    await service.runAttendance({
      accountsFile: accountsFile ?? '',
      stateDir: options['state-dir'],
      forceRun: options.force === 'true' || options.force === '1' || options.force === '',
    })
    return
  }

  if (command === 'login') {
    const accountsFile = requireOption(options, 'accounts-file')
      await service.runLogin({
        mode: requireOption(options, 'mode'),
        phone: requireOption(options, 'phone'),
        password: options.password ?? process.env.TAYGEDO_LOGIN_PASSWORD ?? process.env.TAYGEDO_PASSWORD,
        captcha: options.captcha,
        deviceId: options['device-id'],
        accountId: options['account-id'],
        accountName: options['account-name'],
        accountsFile,
        credentialKey: options['credential-key'],
        credentialKeyPath: options['credential-key-file'],
      })
    return
  }

  throw new Error('Usage: local-cli attendance|login --accounts-file <path>')
}

function createDefaultService(): LocalCliService {
  return {
    async runAttendance(options) {
      const config = loadRuntimeConfig({
        ...process.env,
        TAYGEDO_ACCOUNT_STORE: process.env.TAYGEDO_ACCOUNT_STORE ?? 'file',
        TAYGEDO_STATE_STORE: process.env.TAYGEDO_STATE_STORE ?? 'file',
      })
      const credentialKey = config.credentialKey ?? (config.credentialKeyPath
        ? await loadOrCreateCredentialKey(config.credentialKeyPath)
        : undefined)
      await new AttendanceService({
        accountStore: createAccountStore({ config, accountsFile: options.accountsFile }),
        stateStore: createStateStore({ config, stateDir: options.stateDir }),
        accountPasswords: config.accountPasswords,
        credentialKey,
        notificationUrls: config.notificationUrls,
        maxRetries: config.maxRetries,
        forceRun: options.forceRun ?? config.forceRun,
      }).run()
    },
    async runLogin(options) {
      const credentialKeyPath = options.credentialKeyPath ?? process.env.TAYGEDO_CREDENTIAL_KEY_PATH
      const generatedCredentialKey = options.credentialKey ?? process.env.TAYGEDO_CREDENTIAL_KEY ?? (credentialKeyPath
        ? await loadOrCreateCredentialKey(credentialKeyPath)
        : undefined)
      await new LoginService().runLogin({
        ...options,
        credentialKey: generatedCredentialKey,
      })
    },
    async sendLoginCode(options) {
      await new LoginService().sendLoginCode(options)
    },
  }
}

function parseArgs(args: string[]): Record<string, string | undefined> {
  const parsed: Record<string, string | undefined> = {}
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (!arg?.startsWith('--')) {
      continue
    }
    const next = args[index + 1]
    if (!next || next.startsWith('--')) {
      parsed[arg.slice(2)] = ''
      continue
    }
    parsed[arg.slice(2)] = next
    index++
  }
  return parsed
}

function requireOption(options: Record<string, string | undefined>, key: string): string {
  const value = options[key]
  if (!value) {
    throw new Error(`Missing required option --${key}`)
  }
  return value
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runLocalCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
