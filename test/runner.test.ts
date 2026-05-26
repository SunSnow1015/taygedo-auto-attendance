import { describe, expect, it, vi } from 'vitest'
import { runAttendance } from '../src/runner.js'
import { encryptPassword } from '../src/config/credentials.js'
import { MemoryStateStore } from '../src/stores/state-store.js'

describe('runAttendance', () => {
  const shanghaiNoon = new Date('2026-05-26T04:00:00.000Z')

  it('keeps failed account refresh tokens unchanged in the updated secret payload', async () => {
    const secretWriter = vi.fn()
    const api = {
      refreshToken: vi.fn()
        .mockResolvedValueOnce({ accessToken: 'access-main', refreshToken: 'new-main' })
        .mockRejectedValueOnce(new Error('expired')),
      getGameRoles: vi.fn().mockResolvedValue({ roles: [{ roleId: 'role-1', roleName: '角色一' }] }),
      appSignin: vi.fn().mockResolvedValue({ exp: 10, goldCoin: 20 }),
      getSigninState: vi.fn().mockResolvedValue({ days: 1 }),
      getSigninRewards: vi.fn().mockResolvedValue([{ name: '奖励一', num: 1 }]),
      gameSignin: vi.fn().mockResolvedValue(undefined),
    }

    const result = await runAttendance({
      accountsSecret: JSON.stringify([
        {
          id: 'main',
          name: '主账号',
          uid: '1',
          deviceId: 'device-1',
          refreshToken: 'old-main',
        },
        {
          id: 'alt',
          name: '备用账号',
          uid: '2',
          deviceId: 'device-2',
          refreshToken: 'old-alt',
        },
      ]),
      api,
      notificationUrls: [],
      maxRetries: 1,
      secretWriter,
    })

    expect(result.updatedAccounts).toEqual([
      {
        id: 'main',
        name: '主账号',
        uid: '1',
        deviceId: 'device-1',
        accessToken: 'access-main',
        refreshToken: 'new-main',
        tokenUpdatedAt: expect.any(String),
        roleId: 'role-1',
        roleName: '角色一',
      },
      {
        id: 'alt',
        name: '备用账号',
        uid: '2',
        deviceId: 'device-2',
        refreshToken: 'old-alt',
      },
    ])
    expect(secretWriter).toHaveBeenCalledWith(JSON.stringify(result.updatedAccounts, null, 2))
  })

  it('does not write the secret when every account fails before refresh completes', async () => {
    const secretWriter = vi.fn()
    const api = {
      refreshToken: vi.fn().mockRejectedValue(new Error('expired')),
      getGameRoles: vi.fn(),
      appSignin: vi.fn(),
      getSigninState: vi.fn(),
      getSigninRewards: vi.fn(),
      gameSignin: vi.fn(),
    }

    await runAttendance({
      accountsSecret: JSON.stringify([
        {
          id: 'main',
          name: '主账号',
          uid: '1',
          deviceId: 'device-1',
          refreshToken: 'old-main',
        },
      ]),
      api,
      secretWriter,
    })

    expect(secretWriter).not.toHaveBeenCalled()
  })

  it('uses a stored accessToken without refreshing or writing the secret', async () => {
    const secretWriter = vi.fn()
    const api = {
      refreshToken: vi.fn(),
      userCenterLogin: vi.fn(),
      getGameRoles: vi.fn()
        .mockResolvedValueOnce({ roles: [{ roleId: 'role-1256-a', roleName: '幻塔A' }] })
        .mockResolvedValueOnce({ roles: [] })
        .mockResolvedValueOnce({ roles: [] }),
      appSignin: vi.fn().mockResolvedValue({ exp: 10, goldCoin: 20 }),
      getSigninState: vi.fn().mockResolvedValue({ days: 1 }),
      getSigninRewards: vi.fn().mockResolvedValue([{ name: '奖励一', num: 1 }]),
      gameSignin: vi.fn().mockResolvedValue(undefined),
    }

    const result = await runAttendance({
      accountsSecret: JSON.stringify([
        {
          id: 'main',
          name: '主账号',
          uid: '1',
          deviceId: 'device-1',
          accessToken: 'stored-access',
          refreshToken: 'old-main',
        },
      ]),
      api,
      maxRetries: 1,
      secretWriter,
    })

    expect(api.refreshToken).not.toHaveBeenCalled()
    expect(api.getGameRoles).toHaveBeenNthCalledWith(1, 'stored-access', '1', 'device-1', '1256')
    expect(api.appSignin).toHaveBeenCalledWith('stored-access', '1', 'device-1')
    expect(api.gameSignin).toHaveBeenCalledWith('stored-access', 'role-1256-a', '1256')
    expect(secretWriter).not.toHaveBeenCalled()
    expect(result.updatedAccounts[0]?.refreshToken).toBe('old-main')
  })

  it('refreshes and writes tokens only after the stored accessToken is rejected', async () => {
    const secretWriter = vi.fn()
    const api = {
      refreshToken: vi.fn().mockResolvedValue({ accessToken: 'new-access', refreshToken: 'new-refresh', uid: '1' }),
      userCenterLogin: vi.fn(),
      getGameRoles: vi.fn()
        .mockRejectedValueOnce(new Error('AUTH_EXPIRED: token expired'))
        .mockResolvedValueOnce({ roles: [{ roleId: 'role-1256-a', roleName: '幻塔A' }] })
        .mockResolvedValueOnce({ roles: [] })
        .mockResolvedValueOnce({ roles: [] }),
      appSignin: vi.fn().mockResolvedValue({ exp: 10, goldCoin: 20 }),
      getSigninState: vi.fn().mockResolvedValue({ days: 1 }),
      getSigninRewards: vi.fn().mockResolvedValue([{ name: '奖励一', num: 1 }]),
      gameSignin: vi.fn().mockResolvedValue(undefined),
    }

    const result = await runAttendance({
      accountsSecret: JSON.stringify([
        {
          id: 'main',
          name: '主账号',
          uid: '1',
          deviceId: 'device-1',
          accessToken: 'stored-access',
          refreshToken: 'old-main',
        },
      ]),
      api,
      maxRetries: 1,
      secretWriter,
    })

    expect(api.refreshToken).toHaveBeenCalledWith('old-main', 'device-1')
    expect(result.updatedAccounts[0]).toEqual(expect.objectContaining({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      tokenUpdatedAt: expect.any(String),
    }))
    expect(secretWriter).toHaveBeenCalledWith(JSON.stringify(result.updatedAccounts, null, 2))
  })

  it('rebuilds the usercenter session from laohu credentials when refresh is rejected', async () => {
    const secretWriter = vi.fn()
    const api = {
      refreshToken: vi.fn().mockRejectedValue(new Error('REFRESH_REJECTED_402: refreshToken 已失效，请重新登录')),
      userCenterLogin: vi.fn().mockResolvedValue({ accessToken: 'rebuilt-access', refreshToken: 'rebuilt-refresh', uid: '1' }),
      getGameRoles: vi.fn()
        .mockRejectedValueOnce(new Error('AUTH_EXPIRED: token expired'))
        .mockResolvedValueOnce({ roles: [{ roleId: 'role-1256-a', roleName: '幻塔A' }] })
        .mockResolvedValueOnce({ roles: [] })
        .mockResolvedValueOnce({ roles: [] }),
      appSignin: vi.fn().mockResolvedValue({ exp: 10, goldCoin: 20 }),
      getSigninState: vi.fn().mockResolvedValue({ days: 1 }),
      getSigninRewards: vi.fn().mockResolvedValue([{ name: '奖励一', num: 1 }]),
      gameSignin: vi.fn().mockResolvedValue(undefined),
    }

    const result = await runAttendance({
      accountsSecret: JSON.stringify([
        {
          id: 'main',
          name: '主账号',
          uid: '1',
          deviceId: 'device-1',
          accessToken: 'stored-access',
          refreshToken: 'old-main',
          laohuToken: 'laohu-token',
          laohuUserId: 'laohu-user',
        },
      ]),
      api,
      maxRetries: 1,
      secretWriter,
    })

    expect(api.userCenterLogin).toHaveBeenCalledWith('laohu-token', 'laohu-user', 'device-1')
    expect(result.updatedAccounts[0]).toEqual(expect.objectContaining({
      accessToken: 'rebuilt-access',
      refreshToken: 'rebuilt-refresh',
      laohuToken: 'laohu-token',
      laohuUserId: 'laohu-user',
      tokenUpdatedAt: expect.any(String),
    }))
    expect(secretWriter).toHaveBeenCalledWith(JSON.stringify(result.updatedAccounts, null, 2))
  })

  it('uses an environment password before refresh when the stored accessToken is rejected', async () => {
    const secretWriter = vi.fn()
    const api = {
      loginWithPassword: vi.fn().mockResolvedValue({ token: 'new-laohu-token', userId: 'new-laohu-user' }),
      refreshToken: vi.fn(),
      userCenterLogin: vi.fn().mockResolvedValue({ accessToken: 'password-access', refreshToken: 'password-refresh', uid: '1' }),
      getGameRoles: vi.fn()
        .mockRejectedValueOnce(new Error('AUTH_EXPIRED: token expired'))
        .mockResolvedValueOnce({ roles: [{ roleId: 'role-1256-a', roleName: '幻塔A' }] })
        .mockResolvedValueOnce({ roles: [] })
        .mockResolvedValueOnce({ roles: [] }),
      appSignin: vi.fn().mockResolvedValue({ exp: 10, goldCoin: 20 }),
      getSigninState: vi.fn().mockResolvedValue({ days: 1 }),
      getSigninRewards: vi.fn().mockResolvedValue([{ name: '奖励一', num: 1 }]),
      gameSignin: vi.fn().mockResolvedValue(undefined),
    }

    const result = await runAttendance({
      accountsSecret: JSON.stringify([
        {
          id: 'main',
          name: '主账号',
          uid: '1',
          deviceId: 'device-1',
          accessToken: 'stored-access',
          refreshToken: 'old-main',
          phone: '13800138000',
        },
      ]),
      api,
      accountPasswords: {
        main: 'secret-password',
      },
      maxRetries: 1,
      secretWriter,
    })

    expect(api.loginWithPassword).toHaveBeenCalledWith('13800138000', 'secret-password', 'device-1')
    expect(api.userCenterLogin).toHaveBeenCalledWith('new-laohu-token', 'new-laohu-user', 'device-1')
    expect(api.refreshToken).not.toHaveBeenCalled()
    expect(result.updatedAccounts[0]).toEqual(expect.objectContaining({
      accessToken: 'password-access',
      refreshToken: 'password-refresh',
      laohuToken: 'new-laohu-token',
      laohuUserId: 'new-laohu-user',
      phone: '13800138000',
      tokenUpdatedAt: expect.any(String),
    }))
    expect(secretWriter).toHaveBeenCalledWith(JSON.stringify(result.updatedAccounts, null, 2))
  })

  it('uses an encrypted account password before refresh when a credential key is configured', async () => {
    const credentialKey = 'test-credential-key'
    const api = {
      loginWithPassword: vi.fn().mockResolvedValue({ token: 'new-laohu-token', userId: 'new-laohu-user' }),
      refreshToken: vi.fn(),
      userCenterLogin: vi.fn().mockResolvedValue({ accessToken: 'password-access', refreshToken: 'password-refresh', uid: '1' }),
      getGameRoles: vi.fn()
        .mockRejectedValueOnce(new Error('AUTH_EXPIRED: token expired'))
        .mockResolvedValueOnce({ roles: [{ roleId: 'role-1256-a', roleName: '幻塔A' }] })
        .mockResolvedValueOnce({ roles: [] })
        .mockResolvedValueOnce({ roles: [] }),
      appSignin: vi.fn().mockResolvedValue({ exp: 10, goldCoin: 20 }),
      getSigninState: vi.fn().mockResolvedValue({ days: 1 }),
      getSigninRewards: vi.fn().mockResolvedValue([{ name: '奖励一', num: 1 }]),
      gameSignin: vi.fn().mockResolvedValue(undefined),
    }

    await runAttendance({
      accountsSecret: JSON.stringify([
        {
          id: 'main',
          name: '主账号',
          uid: '1',
          deviceId: 'device-1',
          accessToken: 'stored-access',
          refreshToken: 'old-main',
          phone: '13800138000',
          encryptedPassword: encryptPassword('secret-password', credentialKey),
        },
      ]),
      api,
      credentialKey,
      maxRetries: 1,
    })

    expect(api.loginWithPassword).toHaveBeenCalledWith('13800138000', 'secret-password', 'device-1')
    expect(api.refreshToken).not.toHaveBeenCalled()
  })

  it('falls back to refresh when password relogin fails', async () => {
    const api = {
      loginWithPassword: vi.fn().mockRejectedValue(new Error('password login failed')),
      refreshToken: vi.fn().mockResolvedValue({ accessToken: 'new-access', refreshToken: 'new-refresh', uid: '1' }),
      userCenterLogin: vi.fn(),
      getGameRoles: vi.fn()
        .mockRejectedValueOnce(new Error('AUTH_EXPIRED: token expired'))
        .mockResolvedValueOnce({ roles: [{ roleId: 'role-1256-a', roleName: '幻塔A' }] })
        .mockResolvedValueOnce({ roles: [] })
        .mockResolvedValueOnce({ roles: [] }),
      appSignin: vi.fn().mockResolvedValue({ exp: 10, goldCoin: 20 }),
      getSigninState: vi.fn().mockResolvedValue({ days: 1 }),
      getSigninRewards: vi.fn().mockResolvedValue([{ name: '奖励一', num: 1 }]),
      gameSignin: vi.fn().mockResolvedValue(undefined),
    }

    const result = await runAttendance({
      accountsSecret: JSON.stringify([
        {
          id: 'main',
          name: '主账号',
          uid: '1',
          deviceId: 'device-1',
          accessToken: 'stored-access',
          refreshToken: 'old-main',
          phone: '13800138000',
        },
      ]),
      api,
      accountPasswords: {
        main: 'secret-password',
      },
      maxRetries: 1,
    })

    expect(api.loginWithPassword).toHaveBeenCalledTimes(1)
    expect(api.refreshToken).toHaveBeenCalledWith('old-main', 'device-1')
    expect(result.updatedAccounts[0]).toEqual(expect.objectContaining({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      phone: '13800138000',
    }))
  })

  it('does not write the secret when refresh is rejected and no laohu credentials are available', async () => {
    const secretWriter = vi.fn()
    const api = {
      refreshToken: vi.fn().mockRejectedValue(new Error('REFRESH_REJECTED_402: refreshToken 已失效，请重新登录')),
      userCenterLogin: vi.fn(),
      getGameRoles: vi.fn(),
      appSignin: vi.fn(),
      getSigninState: vi.fn(),
      getSigninRewards: vi.fn(),
      gameSignin: vi.fn(),
    }

    const result = await runAttendance({
      accountsSecret: JSON.stringify([
        {
          id: 'main',
          name: '主账号',
          uid: '1',
          deviceId: 'device-1',
          refreshToken: 'old-main',
        },
      ]),
      api,
      maxRetries: 1,
      secretWriter,
    })

    expect(secretWriter).not.toHaveBeenCalled()
    expect(result.updatedAccounts[0]?.refreshToken).toBe('old-main')
    expect(result.summary).toContain('refreshToken 已失效')
  })

  it('retries transient account failures before marking an account failed', async () => {
    const api = {
      refreshToken: vi.fn()
        .mockRejectedValueOnce(new Error('temporary'))
        .mockResolvedValueOnce({ accessToken: 'access-main', refreshToken: 'new-main' }),
      getGameRoles: vi.fn().mockResolvedValue({ roles: [{ roleId: 'role-1', roleName: '角色一' }] }),
      appSignin: vi.fn().mockResolvedValue({ exp: 10, goldCoin: 20 }),
      getSigninState: vi.fn().mockResolvedValue({ days: 1 }),
      getSigninRewards: vi.fn().mockResolvedValue([{ name: '奖励一', num: 1 }]),
      gameSignin: vi.fn().mockResolvedValue(undefined),
    }

    const result = await runAttendance({
      accountsSecret: JSON.stringify([
        {
          id: 'main',
          name: '主账号',
          uid: '1',
          deviceId: 'device-1',
          refreshToken: 'old-main',
        },
      ]),
      api,
      maxRetries: 2,
    })

    expect(api.refreshToken).toHaveBeenCalledTimes(2)
    expect(result.updatedAccounts[0]?.refreshToken).toBe('new-main')
  })

  it('signs all known games for each account', async () => {
    const api = {
      refreshToken: vi.fn().mockResolvedValue({ accessToken: 'access-main', refreshToken: 'new-main' }),
      getGameRoles: vi.fn()
        .mockResolvedValueOnce({ roles: [{ roleId: 'role-1256-a', roleName: '幻塔A' }] })
        .mockResolvedValueOnce({ roles: [{ roleId: 'role-1257-a', roleName: '异环A' }] })
        .mockResolvedValueOnce({ roles: [{ roleId: 'role-1289-a', roleName: '第三游戏A' }] }),
      appSignin: vi.fn().mockResolvedValue({ exp: 10, goldCoin: 20 }),
      getSigninState: vi.fn().mockResolvedValue({ days: 1 }),
      getSigninRewards: vi.fn().mockResolvedValue([{ name: '奖励一', num: 1 }]),
      gameSignin: vi.fn().mockResolvedValue(undefined),
    }

    const result = await runAttendance({
      accountsSecret: JSON.stringify([
        {
          id: 'main',
          name: '主账号',
          uid: '1',
          deviceId: 'device-1',
          refreshToken: 'old-main',
        },
      ]),
      api,
      maxRetries: 1,
    })

    expect(api.getGameRoles).toHaveBeenCalledTimes(3)
    expect(api.gameSignin).toHaveBeenCalledTimes(3)
    expect(api.gameSignin).toHaveBeenNthCalledWith(1, 'access-main', 'role-1256-a', '1256')
    expect(api.gameSignin).toHaveBeenNthCalledWith(2, 'access-main', 'role-1257-a', '1257')
    expect(api.gameSignin).toHaveBeenNthCalledWith(3, 'access-main', 'role-1289-a', '1289')
    expect(result.updatedAccounts[0]?.roleId).toBe('role-1256-a')
    expect(result.updatedAccounts[0]?.roleName).toBe('幻塔A')
  })

  it('builds a readable Chinese summary with account rewards and game rewards', async () => {
    const api = {
      refreshToken: vi.fn().mockResolvedValue({ accessToken: 'access-main', refreshToken: 'new-main' }),
      getGameRoles: vi.fn()
        .mockResolvedValueOnce({ roles: [{ roleId: 'role-1256-a', roleName: '幻塔A' }] })
        .mockResolvedValueOnce({ roles: [] })
        .mockResolvedValueOnce({ roles: [] }),
      appSignin: vi.fn().mockResolvedValue({ exp: 10, goldCoin: 20 }),
      getSigninState: vi.fn().mockResolvedValue({ days: 1 }),
      getSigninRewards: vi.fn().mockResolvedValue([{ name: '墨晶', num: 5 }]),
      gameSignin: vi.fn().mockResolvedValue(undefined),
    }

    const result = await runAttendance({
      accountsSecret: JSON.stringify([
        {
          id: 'main',
          name: '主账号',
          uid: '1',
          deviceId: 'device-1',
          refreshToken: 'old-main',
        },
      ]),
      api,
      maxRetries: 1,
    })

    expect(result.summary).toContain('塔吉多每日签到结果')
    expect(result.summary).toContain('总账号：1，成功：1，失败：0')
    expect(result.summary).toContain('主账号（main）：成功')
    expect(result.summary).toContain('APP 签到：获得 20 金币，10 经验')
    expect(result.summary).toContain('游戏 1256 / 幻塔A：签到成功，本月第 1 天，奖励 墨晶 x5')
  })

  it('skips accounts that already succeeded today in state storage', async () => {
    const stateStore = new MemoryStateStore('test')
    await stateStore.set('attendance:main:2026-05-26', { status: 'success' })
    const api = {
      refreshToken: vi.fn(),
      getGameRoles: vi.fn(),
      appSignin: vi.fn(),
      getSigninState: vi.fn(),
      getSigninRewards: vi.fn(),
      gameSignin: vi.fn(),
    }

    const result = await runAttendance({
      accountsSecret: JSON.stringify([
        { id: 'main', name: '主账号', uid: '1', deviceId: 'device-1', refreshToken: 'old-main' },
      ]),
      api,
      stateStore,
      now: shanghaiNoon,
    })

    expect(api.refreshToken).not.toHaveBeenCalled()
    expect(result.skippedCount).toBe(1)
    expect(result.accounts[0]).toEqual(expect.objectContaining({
      id: 'main',
      status: 'skipped',
    }))
    expect(result.summary).toContain('跳过：1')
  })

  it('force runs accounts even when today already succeeded', async () => {
    const stateStore = new MemoryStateStore('test')
    await stateStore.set('attendance:main:2026-05-26', { status: 'success' })
    const api = {
      refreshToken: vi.fn().mockResolvedValue({ accessToken: 'access-main', refreshToken: 'new-main' }),
      getGameRoles: vi.fn().mockResolvedValue({ roles: [] }),
      appSignin: vi.fn().mockResolvedValue({ exp: 10, goldCoin: 20 }),
      getSigninState: vi.fn(),
      getSigninRewards: vi.fn(),
      gameSignin: vi.fn(),
    }

    const result = await runAttendance({
      accountsSecret: JSON.stringify([
        { id: 'main', name: '主账号', uid: '1', deviceId: 'device-1', refreshToken: 'old-main' },
      ]),
      api,
      stateStore,
      forceRun: true,
      now: shanghaiNoon,
    })

    expect(api.refreshToken).toHaveBeenCalledWith('old-main', 'device-1')
    expect(result.forceRun).toBe(true)
    expect(result.skippedCount).toBe(0)
    expect(result.successCount).toBe(1)
    await expect(stateStore.get('attendance:main:2026-05-26')).resolves.toEqual(expect.objectContaining({
      status: 'success',
      accountId: 'main',
    }))
  })

  it('saves structured run history and notification failures without failing attendance', async () => {
    const stateStore = new MemoryStateStore('test')
    const api = {
      refreshToken: vi.fn().mockResolvedValue({ accessToken: 'access-main', refreshToken: 'new-main' }),
      getGameRoles: vi.fn().mockResolvedValue({ roles: [] }),
      appSignin: vi.fn().mockResolvedValue({ exp: 10, goldCoin: 20 }),
      getSigninState: vi.fn(),
      getSigninRewards: vi.fn(),
      gameSignin: vi.fn(),
    }
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('webhook down'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const result = await runAttendance({
      accountsSecret: JSON.stringify([
        { id: 'main', name: '主账号', uid: '1', deviceId: 'device-1', refreshToken: 'old-main' },
      ]),
      api,
      stateStore,
      notificationUrls: ['https://example.com/a', 'https://example.com/b'],
      notificationFetch: fetchMock,
      now: shanghaiNoon,
    })

    expect(result.notificationErrors).toEqual([{
      url: 'https://example.com/a',
      error: 'webhook down',
    }])
    await expect(stateStore.get('last-summary')).resolves.toContain('塔吉多每日签到结果')
    await expect(stateStore.get('last-run')).resolves.toEqual(expect.objectContaining({
      forceRun: false,
      totalCount: 1,
      successCount: 1,
      failedCount: 0,
      skippedCount: 0,
      notificationErrors: result.notificationErrors,
      accounts: [expect.objectContaining({
        id: 'main',
        status: 'success',
        appSignin: { exp: 10, goldCoin: 20 },
      })],
    }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rebuilds the session and retries when a later signed request reports auth expired', async () => {
    const api = {
      refreshToken: vi.fn().mockResolvedValue({ accessToken: 'new-access', refreshToken: 'new-refresh', uid: '1' }),
      userCenterLogin: vi.fn(),
      getGameRoles: vi.fn()
        .mockResolvedValueOnce({ roles: [{ roleId: 'role-1', roleName: '角色一' }] })
        .mockResolvedValueOnce({ roles: [] })
        .mockResolvedValueOnce({ roles: [] })
        .mockResolvedValueOnce({ roles: [{ roleId: 'role-1', roleName: '角色一' }] })
        .mockResolvedValueOnce({ roles: [] })
        .mockResolvedValueOnce({ roles: [] }),
      appSignin: vi.fn()
        .mockRejectedValueOnce(new Error('AUTH_EXPIRED: token expired'))
        .mockResolvedValueOnce({ exp: 10, goldCoin: 20 }),
      getSigninState: vi.fn().mockResolvedValue({ days: 1 }),
      getSigninRewards: vi.fn().mockResolvedValue([{ name: '奖励一', num: 1 }]),
      gameSignin: vi.fn().mockResolvedValue(undefined),
    }

    const result = await runAttendance({
      accountsSecret: JSON.stringify([
        {
          id: 'main',
          name: '主账号',
          uid: '1',
          deviceId: 'device-1',
          accessToken: 'stored-access',
          refreshToken: 'old-main',
        },
      ]),
      api,
      maxRetries: 1,
    })

    expect(api.refreshToken).toHaveBeenCalledTimes(1)
    expect(api.appSignin).toHaveBeenNthCalledWith(2, 'new-access', '1', 'device-1')
    expect(result.successCount).toBe(1)
    expect(result.updatedAccounts[0]).toEqual(expect.objectContaining({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
    }))
  })
})
