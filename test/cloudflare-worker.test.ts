import { describe, expect, it, vi } from 'vitest'
import worker, { constantTimeTokenMatches } from '../src/runtimes/cloudflare-worker.js'

type ScheduledController = Record<string, unknown>
type ExecutionContext = Record<string, unknown>

describe('cloudflare worker runtime', () => {
  it('runs attendance from scheduled events and stores the latest summary', async () => {
    const kv = new Map<string, string>()
    kv.set('TAYGEDO_ACCOUNTS', JSON.stringify([
      { id: 'main', name: '主账号', uid: '1', deviceId: 'device-1', refreshToken: 'refresh' },
    ]))
    const env = createEnv(kv)

    await worker.scheduled({} as ScheduledController, env, {} as ExecutionContext)

    expect(kv.get('taygedo:last-summary')).toContain('塔吉多每日签到结果')
    expect(JSON.parse(kv.get('taygedo:worker-status') ?? '{}')).toEqual(expect.objectContaining({
      version: 1,
      latest: expect.objectContaining({
        trigger: 'scheduled',
        executionStatus: 'completed',
        outcome: 'success',
        successCount: 1,
        failedCount: 0,
      }),
      history: [expect.objectContaining({ trigger: 'scheduled', outcome: 'success' })],
    }))
  })

  it('requires an admin token for manual trigger', async () => {
    const env = createEnv(new Map(), { TAYGEDO_ADMIN_TOKEN: 'secret' })

    const denied = await worker.fetch(new Request('https://example.com/run'), env, {} as ExecutionContext)
    const allowed = await worker.fetch(new Request('https://example.com/run', {
      headers: { Authorization: 'Bearer secret' },
    }), env, {} as ExecutionContext)

    expect(denied.status).toBe(401)
    expect(allowed.status).toBe(200)
  })

  it('compares admin tokens without short-circuiting on the first mismatch', () => {
    const expected = 'Bearer secret'

    expect(constantTimeTokenMatches(expected, 'Bearer secret')).toBe(true)
    expect(constantTimeTokenMatches(expected, 'Bearer secreu')).toBe(false)
    expect(constantTimeTokenMatches(expected, 'Bearer x')).toBe(false)
    expect(constantTimeTokenMatches(expected, null)).toBe(false)
  })

  it('protects the status endpoint and returns an empty no-store response before the first run', async () => {
    const env = createEnv(new Map(), { TAYGEDO_ADMIN_TOKEN: 'secret' })

    const denied = await worker.fetch(new Request('https://example.com/status'), env, {} as ExecutionContext)
    const allowed = await worker.fetch(new Request('https://example.com/status', {
      headers: { Authorization: 'Bearer secret' },
    }), env, {} as ExecutionContext)

    expect(denied.status).toBe(401)
    expect(denied.headers.get('cache-control')).toBe('no-store')
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get('cache-control')).toBe('no-store')
    expect(await allowed.json()).toEqual({ ok: true, latest: null, history: [] })
  })

  it('fails closed on every management endpoint when the admin token is not configured', async () => {
    const env = createEnv(new Map())
    const requests = [
      new Request('https://example.com/status'),
      new Request('https://example.com/run'),
      new Request('https://example.com/login', { method: 'POST' }),
    ]

    for (const request of requests) {
      const response = await worker.fetch(request, env, {} as ExecutionContext)
      expect(response.status).toBe(503)
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
    expect(env.TAYGEDO_TEST_API.refreshToken).not.toHaveBeenCalled()
    expect(env.TAYGEDO_TEST_LOGIN_API.loginWithPassword).not.toHaveBeenCalled()
  })

  it('projects legacy last-run data through a strict status DTO without exposing secrets', async () => {
    const kv = new Map<string, string>()
    kv.set('taygedo:last-run', JSON.stringify({
      startedAt: '2026-05-26T00:00:00.000Z',
      finishedAt: '2026-05-26T00:00:01.000Z',
      forceRun: false,
      totalCount: 1,
      successCount: 1,
      failedCount: 0,
      skippedCount: 0,
      accessToken: 'sensitive-access-token',
      refreshToken: 'sensitive-refresh-token',
      notificationErrors: [{
        url: 'https://sctapi.ftqq.com/sensitive-sendkey.send',
        error: 'webhook failed with sensitive-laohu-token',
      }],
      accounts: [{
        id: 'main',
        name: '主账号',
        status: 'success',
        success: true,
        encryptedPassword: 'sensitive-encrypted-password',
        deviceId: 'sensitive-device-id',
        appSignin: { alreadySigned: true },
        gameSignins: [],
      }],
    }))
    const env = createEnv(kv, { TAYGEDO_ADMIN_TOKEN: 'secret' })

    const response = await worker.fetch(new Request('https://example.com/status', {
      headers: { Authorization: 'Bearer secret' },
    }), env, {} as ExecutionContext)
    const body = await response.json() as Record<string, unknown>
    const serialized = JSON.stringify(body)

    expect(response.status).toBe(200)
    expect(body).toEqual(expect.objectContaining({
      latest: expect.objectContaining({
        trigger: 'unknown',
        outcome: 'success',
        notificationErrorCount: 1,
        accounts: [expect.objectContaining({ id: 'main', status: 'success' })],
      }),
    }))
    for (const secret of [
      'sensitive-access-token',
      'sensitive-refresh-token',
      'sensitive-sendkey',
      'sensitive-laohu-token',
      'sensitive-encrypted-password',
      'sensitive-device-id',
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('force runs manual attendance from the query string', async () => {
    const kv = new Map<string, string>()
    const env = createEnv(kv, { TAYGEDO_ADMIN_TOKEN: 'secret' })
    kv.set('taygedo:attendance:main:2026-05-26', JSON.stringify({ status: 'success' }))

    const response = await worker.fetch(new Request('https://example.com/run?force=1', {
      headers: { Authorization: 'Bearer secret' },
    }), env, {} as ExecutionContext)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(expect.objectContaining({
      ok: true,
      forceRun: true,
    }))
    expect(env.TAYGEDO_TEST_API.refreshToken).toHaveBeenCalled()
    expect(JSON.parse(kv.get('taygedo:worker-status') ?? '{}').latest).toEqual(expect.objectContaining({
      trigger: 'manual',
      forceRun: true,
    }))
  })

  it('records a Worker-level failure instead of leaving an older success looking current', async () => {
    const kv = new Map<string, string>()
    kv.set('taygedo:worker-status', JSON.stringify({
      version: 1,
      latest: storedRunStatus({ startedAt: '2026-05-25T00:00:00.000Z', outcome: 'success' }),
      history: [],
    }))
    const env = createEnv(kv)
    env.TAYGEDO_ACCOUNTS = 'not-json'

    await expect(worker.scheduled({} as ScheduledController, env, {} as ExecutionContext)).rejects.toThrow()

    expect(JSON.parse(kv.get('taygedo:worker-status') ?? '{}').latest).toEqual(expect.objectContaining({
      trigger: 'scheduled',
      executionStatus: 'failed',
      outcome: 'execution-failed',
    }))
  })

  it('stores Worker status under the configured state prefix', async () => {
    const kv = new Map<string, string>()
    const env = createEnv(kv, { TAYGEDO_STATE_PREFIX: 'production' })

    await worker.scheduled({} as ScheduledController, env, {} as ExecutionContext)

    expect(kv.get('production:worker-status')).toBeDefined()
    expect(kv.get('taygedo:worker-status')).toBeUndefined()
  })

  it('does not fail a completed attendance run when the status history write fails', async () => {
    const kv = new Map<string, string>()
    const oldStartedAt = '2026-05-25T00:00:00.000Z'
    kv.set('taygedo:worker-status', JSON.stringify({
      version: 1,
      latest: storedRunStatus({
        startedAt: oldStartedAt,
        finishedAt: '2026-05-25T00:00:01.000Z',
      }),
      history: [],
    }))
    const env = createEnv(kv, { TAYGEDO_ADMIN_TOKEN: 'secret' })
    env.KV.put.mockImplementation(async (key: string, value: string) => {
      if (key === 'taygedo:worker-status') {
        throw new Error('status storage unavailable')
      }
      kv.set(key, value)
    })

    await expect(worker.scheduled({} as ScheduledController, env, {} as ExecutionContext)).resolves.toBeUndefined()
    expect(kv.get('taygedo:last-run')).toBeDefined()

    const response = await worker.fetch(new Request('https://example.com/status', {
      headers: { Authorization: 'Bearer secret' },
    }), env, {} as ExecutionContext)
    const status = await response.json() as {
      latest: { startedAt: string, trigger: string }
      history: Array<{ startedAt: string, trigger: string }>
    }
    expect(status.latest.startedAt).not.toBe(oldStartedAt)
    expect(status.latest.trigger).toBe('unknown')
    expect(status.history[0]).toEqual(expect.objectContaining({
      startedAt: status.latest.startedAt,
      trigger: 'unknown',
    }))
  })

  it.each([
    { counts: { totalCount: 2, successCount: 1, failedCount: 1, skippedCount: 0 }, outcome: 'partial' },
    { counts: { successCount: 0, failedCount: 1, skippedCount: 0 }, outcome: 'failed' },
    { counts: { successCount: 0, failedCount: 0, skippedCount: 1 }, outcome: 'skipped' },
  ])('derives $outcome from stored status counts instead of trusting persisted labels', async ({ counts, outcome }) => {
    const kv = new Map<string, string>()
    kv.set('taygedo:worker-status', JSON.stringify({
      version: 1,
      latest: storedRunStatus({ ...counts, outcome: 'success' }),
      history: [],
    }))
    const env = createEnv(kv, { TAYGEDO_ADMIN_TOKEN: 'secret' })

    const response = await worker.fetch(new Request('https://example.com/status', {
      headers: { Authorization: 'Bearer secret' },
    }), env, {} as ExecutionContext)
    const body = await response.json() as { latest?: { outcome?: string } }

    expect(body.latest?.outcome).toBe(outcome)
  })

  it('does not report malformed completed counts as a successful run', async () => {
    const kv = new Map<string, string>()
    kv.set('taygedo:worker-status', JSON.stringify({
      version: 1,
      latest: storedRunStatus({
        totalCount: 2,
        successCount: 1,
        failedCount: 0,
        skippedCount: 0,
      }),
      history: [],
    }))
    const env = createEnv(kv, { TAYGEDO_ADMIN_TOKEN: 'secret' })

    const response = await worker.fetch(new Request('https://example.com/status', {
      headers: { Authorization: 'Bearer secret' },
    }), env, {} as ExecutionContext)
    const body = await response.json() as { latest?: { outcome?: string } }

    expect(body.latest?.outcome).toBe('failed')
  })

  it('records an empty account configuration as failed instead of successful', async () => {
    const kv = new Map<string, string>()
    const env = createEnv(kv, { TAYGEDO_ACCOUNTS: '[]' })

    await worker.scheduled({} as ScheduledController, env, {} as ExecutionContext)

    expect(JSON.parse(kv.get('taygedo:worker-status') ?? '{}').latest).toEqual(expect.objectContaining({
      totalCount: 0,
      outcome: 'failed',
    }))
  })

  it('repairs corrupt status history and keeps only the newest 30 compact entries', async () => {
    const kv = new Map<string, string>()
    const env = createEnv(kv)
    kv.set('taygedo:worker-status', '{invalid-json')

    await expect(worker.scheduled({} as ScheduledController, env, {} as ExecutionContext)).resolves.toBeUndefined()
    const repaired = JSON.parse(kv.get('taygedo:worker-status') ?? '{}')
    expect(repaired.history).toHaveLength(1)

    kv.set('taygedo:worker-status', JSON.stringify({
      version: 1,
      latest: storedRunStatus(),
      history: Array.from({ length: 35 }, (_, index) => {
        const startedAt = new Date(Date.UTC(2026, 4, index + 1)).toISOString()
        const finishedAt = new Date(Date.parse(startedAt) + 1000).toISOString()
        return {
          ...storedRunStatus({ startedAt, finishedAt }),
          accounts: undefined,
        }
      }),
    }))

    await worker.scheduled({} as ScheduledController, env, {} as ExecutionContext)
    const bounded = JSON.parse(kv.get('taygedo:worker-status') ?? '{}')
    expect(bounded.history).toHaveLength(30)
    expect(bounded.history[0]).toEqual(expect.objectContaining({ trigger: 'scheduled' }))
  })

  it('logs in with a password through a protected endpoint and stores accounts without plaintext password', async () => {
    const kv = new Map<string, string>()
    const env = createEnv(kv, { TAYGEDO_ADMIN_TOKEN: 'secret', TAYGEDO_CREDENTIAL_KEY: 'test-credential-key' })

    const denied = await worker.fetch(new Request('https://example.com/login', {
      method: 'POST',
      body: JSON.stringify({
        mode: 'password',
        phone: '13800138000',
        password: 'secret-password',
        accountId: 'main',
        accountName: '主账号',
      }),
    }), env, {} as ExecutionContext)
    const allowed = await worker.fetch(new Request('https://example.com/login', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
      body: JSON.stringify({
        mode: 'password',
        phone: '13800138000',
        password: 'secret-password',
        accountId: 'main',
        accountName: '主账号',
      }),
    }), env, {} as ExecutionContext)

    expect(denied.status).toBe(401)
    expect(allowed.status).toBe(200)
    expect(kv.get('TAYGEDO_ACCOUNTS')).toBeDefined()
    expect(kv.get('TAYGEDO_ACCOUNTS')).not.toContain('secret-password')
    expect(JSON.parse(kv.get('TAYGEDO_ACCOUNTS') ?? '[]')[0].encryptedPassword).toBeDefined()
  })

  it('rejects password login without a credential key on Cloudflare', async () => {
    const env = createEnv(new Map(), { TAYGEDO_ADMIN_TOKEN: 'secret' })

    const response = await worker.fetch(new Request('https://example.com/login', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
      body: JSON.stringify({
        mode: 'password',
        phone: '13800138000',
        password: 'secret-password',
        accountId: 'main',
      }),
    }), env, {} as ExecutionContext)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual(expect.objectContaining({
      error: expect.stringContaining('TAYGEDO_CREDENTIAL_KEY'),
    }))
  })

  it('rejects invalid Cloudflare login request fields before calling the login service', async () => {
    const kv = new Map<string, string>()
    const env = createEnv(kv, { TAYGEDO_ADMIN_TOKEN: 'secret', TAYGEDO_CREDENTIAL_KEY: 'test-credential-key' })

    const response = await worker.fetch(new Request('https://example.com/login', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
      body: JSON.stringify({
        mode: 'password',
        phone: 'not-a-phone',
        password: 'secret-password',
        accountId: '../main',
      }),
    }), env, {} as ExecutionContext)

    expect(response.status).toBe(400)
    expect(env.TAYGEDO_TEST_LOGIN_API.loginWithPassword).not.toHaveBeenCalled()
  })

  it('returns upstream login failures as JSON instead of throwing a Worker exception', async () => {
    const env = createEnv(new Map(), { TAYGEDO_ADMIN_TOKEN: 'secret', TAYGEDO_CREDENTIAL_KEY: 'test-credential-key' })
    env.TAYGEDO_TEST_LOGIN_API.loginWithPassword.mockRejectedValueOnce(new Error('系统错误'))

    const response = await worker.fetch(new Request('https://example.com/login', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
      body: JSON.stringify({
        mode: 'password',
        phone: '13800138000',
        password: 'secret-password',
        accountId: 'main',
      }),
    }), env, {} as ExecutionContext)

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: '系统错误' })
  })

  it('treats Cloudflare login without mode as password login when checking credential key', async () => {
    const env = createEnv(new Map(), { TAYGEDO_ADMIN_TOKEN: 'secret' })

    const response = await worker.fetch(new Request('https://example.com/login', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
      body: JSON.stringify({
        phone: '13800138000',
        password: 'secret-password',
        accountId: 'main',
      }),
    }), env, {} as ExecutionContext)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual(expect.objectContaining({
      error: expect.stringContaining('TAYGEDO_CREDENTIAL_KEY'),
    }))
  })

  it('serves a Cloudflare-only login page from the root path', async () => {
    const env = createEnv(new Map(), { TAYGEDO_ADMIN_TOKEN: 'secret' })

    const response = await worker.fetch(new Request('https://example.com/'), env, {} as ExecutionContext)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    expect(html).toContain('塔吉多签到管理')
    expect(html).toContain('最近签到')
    expect(html).toContain('最近 30 次执行')
    expect(html).toContain('id="refresh-status"')
    expect(html).toContain("fetch('/status'")
    expect(html).toContain("headers: { Authorization: 'Bearer ' + token }")
    expect(html).toContain('statusMessage.textContent = message')
    expect(html).toContain('element.textContent = text')
    expect(html).not.toContain('.innerHTML')
    expect(html).toContain('password')
    expect(html).toContain('value="captcha"')
    expect(html).not.toContain('id="send-code"')
    expect(html).not.toContain('value="send-code"')
    expect(html).not.toContain('value="login"')
    expect(html).not.toContain('name="deviceId"')
    expect(html).toContain('startResendCooldown(captchaResendSeconds)')
    expect(html).toContain("submitButton.textContent = '发送验证码'")
    expect(html).toContain('if (!hasCaptchaSession())')
    expect(html).toContain('captchaInput.required = false')
    expect(html).toContain('刚才成功发送的验证码仍可继续登录。')
    expect(html).toContain("const captchaSessionKey = 'taygedoCaptchaSession'")
    expect(html).toContain('const captchaSessionTtlMs = 10 * 60 * 1000')
    expect(html).toContain('sessionStorage.setItem(captchaSessionKey')
    expect(html).toContain('sessionStorage.getItem(captchaSessionKey)')
    expect(html).toContain('sessionStorage.removeItem(captchaSessionKey)')
    expect(html).toContain('age < 0 || age >= captchaSessionTtlMs')
    expect(html).toContain("modeInput.value = 'captcha'")
    expect(html).toContain("result.textContent = '已恢复刚才发送的验证码，可继续填写并登录。'")
    expect(html).toContain("localStorage.getItem('taygedoAdminToken')")
    expect(html).toContain('浏览器禁止本地存储，Token 未保存，但当前页面仍可使用。')
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
    expect(script).toBeTruthy()
    expect(() => new Function(script!)).not.toThrow()
  })

  it('keeps one device id across the integrated captcha login flow', async () => {
    const kv = new Map<string, string>()
    const env = createEnv(kv, { TAYGEDO_ADMIN_TOKEN: 'secret' })

    const sendResponse = await worker.fetch(new Request('https://example.com/login', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
      body: JSON.stringify({
        mode: 'send-code',
        phone: '13800138000',
        accountId: 'main',
      }),
    }), env, {} as ExecutionContext)
    const sent = await sendResponse.json() as { deviceId?: string }

    expect(sendResponse.status).toBe(200)
    expect(sent.deviceId).toEqual(expect.any(String))
    expect(env.TAYGEDO_TEST_LOGIN_API.sendCaptcha).toHaveBeenCalledWith('13800138000', sent.deviceId)

    const loginResponse = await worker.fetch(new Request('https://example.com/login', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
      body: JSON.stringify({
        mode: 'login',
        phone: '13800138000',
        captcha: '123456',
        deviceId: sent.deviceId,
        accountId: 'main',
        accountName: '主账号',
      }),
    }), env, {} as ExecutionContext)

    expect(loginResponse.status).toBe(200)
    expect(env.TAYGEDO_TEST_LOGIN_API.checkCaptcha).not.toHaveBeenCalled()
    expect(env.TAYGEDO_TEST_LOGIN_API.loginWithCaptcha).toHaveBeenCalledWith('13800138000', '123456', sent.deviceId)
    expect(JSON.parse(kv.get('TAYGEDO_ACCOUNTS') ?? '[]')[0]).toEqual(expect.objectContaining({
      id: 'main',
      deviceId: sent.deviceId,
    }))
  })

  it('passes the new-device flag from Cloudflare login requests', async () => {
    const kv = new Map<string, string>()
    const env = createEnv(kv, { TAYGEDO_ADMIN_TOKEN: 'secret', TAYGEDO_CREDENTIAL_KEY: 'test-credential-key' })

    const response = await worker.fetch(new Request('https://example.com/login', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
      body: JSON.stringify({
        mode: 'password',
        phone: '13800138000',
        password: 'secret-password',
        accountId: 'main',
        newDevice: true,
      }),
    }), env, {} as ExecutionContext)

    expect(response.status).toBe(200)
    expect(JSON.parse(kv.get('TAYGEDO_ACCOUNTS') ?? '[]')[0].deviceId).not.toBe('device-1')
  })

  it('does not expose management APIs beyond login on Cloudflare', async () => {
    const env = createEnv(new Map(), { TAYGEDO_ADMIN_TOKEN: 'secret' })

    const response = await worker.fetch(new Request('https://example.com/api/accounts', {
      headers: { Authorization: 'Bearer secret' },
    }), env, {} as ExecutionContext)

    expect(response.status).toBe(404)
  })
})

function createEnv(kv: Map<string, string>, overrides: Partial<Record<string, string>> = {}) {
  const api = {
    refreshToken: vi.fn().mockResolvedValue({ accessToken: 'access', refreshToken: 'refresh-new', uid: '1' }),
    getGameRoles: vi.fn()
      .mockResolvedValueOnce({ roles: [{ roleId: 'role-1', roleName: '角色一' }] })
      .mockResolvedValue({ roles: [] }),
    appSignin: vi.fn().mockResolvedValue({ exp: 10, goldCoin: 20 }),
    getSigninState: vi.fn().mockResolvedValue({ days: 1 }),
    getSigninRewards: vi.fn().mockResolvedValue([{ name: '奖励一', num: 1 }]),
    gameSignin: vi.fn().mockResolvedValue(undefined),
    sendCaptcha: vi.fn().mockResolvedValue(undefined),
    checkCaptcha: vi.fn().mockResolvedValue(undefined),
    loginWithCaptcha: vi.fn().mockResolvedValue({ token: 'laohu-token', userId: 'laohu-user' }),
    loginWithPassword: vi.fn().mockResolvedValue({ token: 'laohu-token', userId: 'laohu-user' }),
    userCenterLogin: vi.fn().mockResolvedValue({ accessToken: 'access', refreshToken: 'refresh-new', uid: '1' }),
    getBindRole: vi.fn().mockResolvedValue({ roleId: 'role-1', roleName: '角色一' }),
  }
  return {
    KV: {
      get: vi.fn(async (key: string) => kv.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => { kv.set(key, value) }),
    },
    TAYGEDO_TEST_API: api,
    TAYGEDO_TEST_LOGIN_API: api,
    TAYGEDO_ACCOUNTS: JSON.stringify([
      { id: 'main', name: '主账号', uid: '1', deviceId: 'device-1', refreshToken: 'refresh' },
    ]),
    ...overrides,
  }
}

function storedRunStatus(overrides: Record<string, unknown> = {}) {
  return {
    startedAt: '2026-05-26T00:00:00.000Z',
    finishedAt: '2026-05-26T00:00:01.000Z',
    trigger: 'scheduled',
    forceRun: false,
    executionStatus: 'completed',
    outcome: 'success',
    totalCount: 1,
    successCount: 1,
    failedCount: 0,
    skippedCount: 0,
    accounts: [],
    notificationErrorCount: 0,
    ...overrides,
  }
}
