import { parseAccountsSecret, type TaygedoAccount } from './config/accounts.js'
import { TaygedoApi } from './taygedo/api.js'
import { sendNotification } from './notify.js'
import { withRetries } from './utils/retry.js'
import { TAYGEDO_GAME_IDS } from './taygedo/games.js'
import { decryptPassword } from './config/credentials.js'
import type { StateStore } from './stores/state-store.js'
import { shanghaiDateTime } from './utils/time.js'

export interface RunnerDependencies {
  accountsSecret: string
  api?: AttendanceApi
  accountPasswords?: Record<string, string>
  credentialKey?: string
  notificationUrls?: string[]
  notificationFetch?: typeof fetch
  maxRetries?: number
  secretWriter?: (payload: string) => Promise<void>
  stateStore?: StateStore
  forceRun?: boolean
  coinTasks?: boolean
  sharePlatform?: string
  delay?: (ms: number) => Promise<void>
  now?: Date
}

type AttendanceApi = Pick<TaygedoApi, 'refreshToken' | 'getGameRoles' | 'appSignin' | 'getSigninState' | 'getSigninRewards' | 'gameSignin'>
  & Partial<Pick<TaygedoApi,
    | 'loginWithPassword'
    | 'userCenterLogin'
    | 'getUserTasks'
    | 'bbsSignin'
    | 'getRecommendPostList'
    | 'getPostFull'
    | 'likePost'
    | 'sharePost'
    | 'getUserCoinTaskState'
  >>

export interface RunAttendanceResult {
  updatedAccounts: TaygedoAccount[]
  summary: string
  startedAt: string
  finishedAt: string
  forceRun: boolean
  accounts: AccountRunSummary[]
  successCount: number
  failedCount: number
  skippedCount: number
  notificationErrors: NotificationError[]
}

export interface CoinTaskSummary {
  bbsSignin?: boolean
  browse: {
    done: number
    target: number
  }
  like: {
    done: number
    target: number
  }
  share: {
    done: number
    target: number
    platform: string
  }
  coinState?: Record<string, unknown>
  error?: string
}

export interface AccountRunSummary {
  id: string
  name: string
  status: 'success' | 'failed' | 'skipped'
  success: boolean
  appSignin?: {
    alreadySigned?: boolean
    exp?: number
    goldCoin?: number
  }
  gameSignins: Array<{
    gameId: string
    roleName: string
    days?: number
    reward?: {
      name: string
      num: number
    }
    alreadySigned?: boolean
    success: boolean
  }>
  coinTasks?: CoinTaskSummary
  error?: string
  skippedReason?: string
}

export interface NotificationError {
  url: string
  error: string
}

export async function runAttendance(deps: RunnerDependencies): Promise<RunAttendanceResult> {
  const startedAtDate = deps.now ?? new Date()
  const startedAt = startedAtDate.toISOString()
  const runDate = shanghaiDate(startedAtDate)
  const forceRun = deps.forceRun ?? false
  const accounts = parseAccountsSecret(deps.accountsSecret)
  const api = deps.api ?? new TaygedoApi()
  const updatedAccounts: TaygedoAccount[] = []
  let secretUpdateCount = 0
  const accountSummaries: AccountRunSummary[] = []

  for (const account of accounts) {
    const stateKey = attendanceStateKey(account.id, runDate)
    try {
      if (!forceRun && await deps.stateStore?.get(stateKey)) {
        updatedAccounts.push({ ...account })
        accountSummaries.push({
          id: account.id,
          name: account.name,
          status: 'skipped',
          success: false,
          gameSignins: [],
          skippedReason: '今天已成功签到',
        })
        continue
      }

      const accountRun = await withRetries(async () => {
        return await runAccount(api, account, deps.accountPasswords ?? {}, deps.credentialKey, {
          coinTasks: deps.coinTasks ?? true,
          sharePlatform: deps.sharePlatform ?? 'qq',
          delay: deps.delay ?? sleep,
        })
      }, deps.maxRetries ?? 3)

      if (accountRun.shouldUpdateSecret) {
        secretUpdateCount++
      }
      updatedAccounts.push(accountRun.updatedAccount)
      accountSummaries.push(accountRun.summary)
      await deps.stateStore?.set(stateKey, {
        status: 'success',
        accountId: account.id,
        accountName: account.name,
        date: runDate,
        updatedAt: new Date().toISOString(),
      }, { ttlSeconds: 60 * 60 * 36 })
    }
    catch (error) {
      updatedAccounts.push({ ...account })
      accountSummaries.push({
        id: account.id,
        name: account.name,
        status: 'failed',
        success: false,
        gameSignins: [],
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (secretUpdateCount > 0 && deps.secretWriter) {
    await deps.secretWriter(JSON.stringify(updatedAccounts, null, 2))
  }

  const summary = buildSummary(accountSummaries)
  console.log(summary)

  const notificationErrors: NotificationError[] = []
  if (deps.notificationUrls?.length) {
    notificationErrors.push(...await sendNotification({
      urls: deps.notificationUrls,
      title: '塔吉多每日签到',
      content: summary,
      fetch: deps.notificationFetch,
    }))
  }

  const successCount = accountSummaries.filter(account => account.status === 'success').length
  const failedCount = accountSummaries.filter(account => account.status === 'failed').length
  const skippedCount = accountSummaries.filter(account => account.status === 'skipped').length
  const finishedAt = new Date().toISOString()
  const result: RunAttendanceResult = {
    updatedAccounts,
    summary,
    startedAt,
    finishedAt,
    forceRun,
    accounts: accountSummaries,
    successCount,
    failedCount,
    skippedCount,
    notificationErrors,
  }
  await deps.stateStore?.set('last-summary', summary)
  await deps.stateStore?.set('last-run', {
    startedAt,
    finishedAt,
    forceRun,
    totalCount: accounts.length,
    successCount,
    failedCount,
    skippedCount,
    accounts: accountSummaries,
    notificationErrors,
  })
  return result
}

interface AccountRunResult {
  updatedAccount: TaygedoAccount
  shouldUpdateSecret: boolean
  summary: AccountRunSummary
}

async function runAccount(
  api: AttendanceApi,
  account: TaygedoAccount,
  accountPasswords: Record<string, string>,
  credentialKey?: string,
  options: AccountRunOptions = {},
): Promise<AccountRunResult> {
  if (account.accessToken) {
    return await signWithRecoverableSession(api, account, account.accessToken, accountPasswords, credentialKey, false, options)
  }

  const session = await refreshOrRebuildSession(api, account, accountPasswords, credentialKey)
  return await signWithRecoverableSession(api, session.account, session.accessToken, accountPasswords, credentialKey, true, options)
}

interface AccountRunOptions {
  coinTasks?: boolean
  sharePlatform?: string
  delay?: (ms: number) => Promise<void>
}

async function refreshOrRebuildSession(
  api: Pick<TaygedoApi, 'refreshToken'> & Partial<Pick<TaygedoApi, 'loginWithPassword' | 'userCenterLogin'>>,
  account: TaygedoAccount,
  accountPasswords: Record<string, string>,
  credentialKey?: string,
): Promise<{ account: TaygedoAccount, accessToken: string }> {
  const password = resolveAccountPassword(account, accountPasswords, credentialKey)
  if (account.phone && password && api.loginWithPassword && api.userCenterLogin) {
    try {
      const login = await api.loginWithPassword(account.phone, password, account.deviceId)
      const rebuilt = await api.userCenterLogin(login.token, login.userId, account.deviceId)
      const updatedAccount = withSession(account, {
        accessToken: rebuilt.accessToken,
        refreshToken: rebuilt.refreshToken,
        uid: rebuilt.uid,
        laohuToken: login.token,
        laohuUserId: login.userId,
      })
      return {
        account: updatedAccount,
        accessToken: rebuilt.accessToken,
      }
    }
    catch {
      // Fall back to refreshToken / stored laohu credentials below.
    }
  }

  try {
    const refreshed = await api.refreshToken(account.refreshToken, account.deviceId)
    const updatedAccount = withSession(account, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      uid: refreshed.uid,
    })
    return {
      account: updatedAccount,
      accessToken: refreshed.accessToken,
    }
  }
  catch (error) {
    if (!isRefreshRejected(error) || !account.laohuToken || !account.laohuUserId || !api.userCenterLogin) {
      throw error
    }
  }

  const rebuilt = await api.userCenterLogin(account.laohuToken, account.laohuUserId, account.deviceId)
  const updatedAccount = withSession(account, {
    accessToken: rebuilt.accessToken,
    refreshToken: rebuilt.refreshToken,
    uid: rebuilt.uid,
  })
  return {
    account: updatedAccount,
    accessToken: rebuilt.accessToken,
  }
}

function resolveAccountPassword(
  account: TaygedoAccount,
  accountPasswords: Record<string, string>,
  credentialKey?: string,
): string | undefined {
  const envPassword = accountPasswords[account.id] ?? accountPasswords[account.phone ?? ''] ?? accountPasswords.default
  if (envPassword) {
    return envPassword
  }
  if (account.encryptedPassword && credentialKey) {
    return decryptPassword(account.encryptedPassword, credentialKey)
  }
  return undefined
}

async function signWithSession(
  api: Pick<TaygedoApi, 'getGameRoles' | 'appSignin' | 'getSigninState' | 'getSigninRewards' | 'gameSignin'>,
  account: TaygedoAccount,
  accessToken: string,
  shouldUpdateSecret: boolean,
  options: AccountRunOptions = {},
): Promise<AccountRunResult> {
  const gameRoles = await getAllGameRoles(api, accessToken, account.uid, account.deviceId)
  const firstRole = gameRoles[0]
  const roleId = firstRole?.roleId ?? account.roleId

  const appSignin = await signAppIdempotently(api, accessToken, account)
  const gameSignins: AccountRunSummary['gameSignins'] = []
  for (const role of gameRoles) {
    const signinState = await api.getSigninState(accessToken, role.gameId)
    const signinRewards = await api.getSigninRewards(accessToken, role.gameId)
    const gameSignin = await signGameIdempotently(api, accessToken, role.roleId, role.gameId)
    gameSignins.push({
      gameId: role.gameId,
      roleName: role.roleName ?? role.roleId,
      days: signinState.days,
      reward: signinRewards[signinState.days - 1],
      alreadySigned: gameSignin.alreadySigned,
      success: true,
    })
  }

  const updatedAccount = {
    ...account,
  }
  if (roleId) {
    updatedAccount.roleId = roleId
  }
  if (firstRole?.roleName ?? account.roleName) {
    updatedAccount.roleName = firstRole?.roleName ?? account.roleName
  }
  const coinTasks = options.coinTasks === false
    ? undefined
    : await runCoinTasks(api as AttendanceApi, account, accessToken, options)

  return {
    updatedAccount,
    shouldUpdateSecret,
    summary: {
      id: account.id,
      name: account.name,
      status: 'success',
      success: true,
      appSignin,
      gameSignins,
      ...(coinTasks ? { coinTasks } : {}),
    },
  }
}

async function signAppIdempotently(
  api: Pick<TaygedoApi, 'appSignin'>,
  accessToken: string,
  account: TaygedoAccount,
): Promise<NonNullable<AccountRunSummary['appSignin']>> {
  try {
    return await api.appSignin(accessToken, account.uid, account.deviceId)
  }
  catch (error) {
    if (!isAlreadySignedError(error)) {
      throw error
    }
    return { alreadySigned: true }
  }
}

async function signGameIdempotently(
  api: Pick<TaygedoApi, 'gameSignin'>,
  accessToken: string,
  roleId: string,
  gameId: string,
): Promise<{ alreadySigned?: boolean }> {
  try {
    await api.gameSignin(accessToken, roleId, gameId)
    return {}
  }
  catch (error) {
    if (!isAlreadySignedError(error)) {
      throw error
    }
    return { alreadySigned: true }
  }
}

function isAlreadySignedError(error: unknown): boolean {
  return error instanceof Error && /已.*签到|签到.*过|重复签到|already.*sign/i.test(error.message)
}

async function signWithRecoverableSession(
  api: AttendanceApi,
  account: TaygedoAccount,
  accessToken: string,
  accountPasswords: Record<string, string>,
  credentialKey: string | undefined,
  shouldUpdateSecret: boolean,
  options: AccountRunOptions = {},
): Promise<AccountRunResult> {
  try {
    return await signWithSession(api, account, accessToken, shouldUpdateSecret, options)
  }
  catch (error) {
    if (!isAuthError(error)) {
      throw error
    }
    const session = await refreshOrRebuildSession(api, account, accountPasswords, credentialKey)
    return await signWithSession(api, session.account, session.accessToken, true, options)
  }
}

async function runCoinTasks(
  api: AttendanceApi,
  account: TaygedoAccount,
  accessToken: string,
  options: AccountRunOptions,
): Promise<CoinTaskSummary | undefined> {
  if (
    !api.getUserTasks
    || !api.bbsSignin
    || !api.getRecommendPostList
    || !api.getPostFull
    || !api.likePost
    || !api.sharePost
    || !api.getUserCoinTaskState
  ) {
    return undefined
  }
  const coinTaskApi = api as AttendanceApi & {
    bbsSignin: NonNullable<AttendanceApi['bbsSignin']>
  }

  const delay = options.delay ?? sleep
  const sharePlatform = options.sharePlatform ?? 'qq'
  const tasks = await api.getUserTasks(accessToken, account.uid, account.deviceId)
  const bbsTarget = remainingTaskCount(tasks, 'signin_c', 1)
  const browseTarget = remainingTaskCount(tasks, 'browse_post_c', 5)
  const likeTarget = remainingTaskCount(tasks, 'like_post_c', 5)
  const shareTarget = remainingTaskCount(tasks, 'share', 1)
  const summary: CoinTaskSummary = {
    bbsSignin: bbsTarget <= 0 ? true : undefined,
    browse: { done: 0, target: browseTarget },
    like: { done: 0, target: likeTarget },
    share: { done: 0, target: shareTarget, platform: sharePlatform },
  }
  const errors: string[] = []

  if (bbsTarget > 0) {
    await signBbsIdempotently(coinTaskApi, accessToken, account)
    summary.bbsSignin = true
  }

  const posts = browseTarget > 0 || likeTarget > 0 || shareTarget > 0
    ? await api.getRecommendPostList(accessToken, account.uid, account.deviceId, 20, 1)
    : []
  const browsedPosts: Array<{ postId: string, selfOperation?: { liked?: boolean } }> = []

  for (const post of posts) {
    if (summary.browse.done >= browseTarget) {
      break
    }
    await delay(randomDelay(700, 1500))
    try {
      const fullPost = await api.getPostFull(accessToken, account.uid, account.deviceId, post.postId)
      browsedPosts.push(fullPost)
      summary.browse.done++
    }
    catch (error) {
      errors.push(`浏览帖子 ${post.postId} 失败：${errorMessage(error)}`)
    }
  }

  const likeCandidates = [...browsedPosts, ...posts]
  const seenPostIds = new Set<string>()
  for (const post of likeCandidates) {
    if (summary.like.done >= likeTarget) {
      break
    }
    if (seenPostIds.has(post.postId)) {
      continue
    }
    seenPostIds.add(post.postId)
    if (post.selfOperation?.liked) {
      continue
    }
    await delay(randomDelay(500, 1000))
    try {
      await api.likePost(accessToken, account.uid, account.deviceId, post.postId)
      summary.like.done++
    }
    catch (error) {
      errors.push(`点赞帖子 ${post.postId} 失败：${errorMessage(error)}`)
    }
  }

  const sharePost = browsedPosts[0] ?? posts[0]
  if (shareTarget > 0 && sharePost) {
    try {
      await api.sharePost(accessToken, account.uid, account.deviceId, sharePost.postId, sharePlatform)
      summary.share.done = 1
    }
    catch (error) {
      errors.push(`分享帖子 ${sharePost.postId} 失败：${errorMessage(error)}`)
    }
  }

  summary.coinState = await api.getUserCoinTaskState(accessToken)
  if (errors.length) {
    summary.error = errors.join('；')
  }
  return summary
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function signBbsIdempotently(
  api: AttendanceApi & { bbsSignin: NonNullable<AttendanceApi['bbsSignin']> },
  accessToken: string,
  account: TaygedoAccount,
): Promise<void> {
  try {
    await api.bbsSignin(accessToken, account.uid, account.deviceId)
  }
  catch (error) {
    if (!isAlreadySignedError(error)) {
      throw error
    }
  }
}

function remainingTaskCount(tasks: Array<{ code: string, completeTimes: number, limitTimes: number }>, code: string, fallback: number): number {
  const task = tasks.find(item => item.code === code)
  if (!task) {
    return fallback
  }
  return Math.max(0, task.limitTimes - task.completeTimes)
}

function withSession(
  account: TaygedoAccount,
  session: { accessToken: string, refreshToken: string, uid?: string, laohuToken?: string, laohuUserId?: string },
): TaygedoAccount {
  const updatedAccount: TaygedoAccount = {
    ...account,
    uid: session.uid ?? account.uid,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    tokenUpdatedAt: shanghaiDateTime(),
  }
  if (session.laohuToken) {
    updatedAccount.laohuToken = session.laohuToken
  }
  if (session.laohuUserId) {
    updatedAccount.laohuUserId = session.laohuUserId
  }
  return updatedAccount
}

function isRefreshRejected(error: unknown): boolean {
  return error instanceof Error && error.message.includes('REFRESH_REJECTED_402')
}

function isAuthError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return /AUTH_EXPIRED|HTTP 40[123]|登录|token|未授权|请先|过期|失效|invalid_token/i.test(error.message)
}

async function getAllGameRoles(
  api: Pick<TaygedoApi, 'getGameRoles'>,
  accessToken: string,
  uid: string,
  deviceId: string,
): Promise<Array<{ gameId: string, roleId: string, roleName?: string }>> {
  const roles: Array<{ gameId: string, roleId: string, roleName?: string }> = []
  const seenRoleIds = new Set<string>()

  for (const gameId of TAYGEDO_GAME_IDS) {
    const gameRoleList = await api.getGameRoles(accessToken, uid, deviceId, gameId)
    for (const role of gameRoleList.roles) {
      if (!role.roleId || seenRoleIds.has(role.roleId)) {
        continue
      }
      seenRoleIds.add(role.roleId)
      roles.push({
        gameId,
        roleId: role.roleId,
        roleName: role.roleName,
      })
    }
  }

  return roles
}

function buildSummary(accounts: AccountRunSummary[]): string {
  const successCount = accounts.filter(account => account.status === 'success').length
  const failedCount = accounts.filter(account => account.status === 'failed').length
  const skippedCount = accounts.filter(account => account.status === 'skipped').length
  const lines = [
    '塔吉多每日签到结果',
    `总账号：${accounts.length}，成功：${successCount}，失败：${failedCount}，跳过：${skippedCount}`,
    '',
  ]

  for (const account of accounts) {
    lines.push(`${account.name}（${account.id}）：${statusLabel(account.status)}`)
    if (account.appSignin) {
      if (account.appSignin.alreadySigned) {
        lines.push('- APP 签到：今日已签到')
      }
      else {
        lines.push(`- APP 签到：获得 ${account.appSignin.goldCoin} 金币，${account.appSignin.exp} 经验`)
      }
    }
    for (const gameSignin of account.gameSignins) {
      const reward = gameSignin.reward ? `，奖励 ${gameSignin.reward.name} x${gameSignin.reward.num}` : ''
      const days = gameSignin.days === undefined ? '' : `，本月第 ${gameSignin.days} 天`
      const signinStatus = gameSignin.alreadySigned ? '今日已签到' : '签到成功'
      lines.push(`- 游戏 ${gameSignin.gameId} / ${gameSignin.roleName}：${signinStatus}${days}${reward}`)
    }
    if (account.coinTasks) {
      lines.push(`- ${formatCoinTasks(account.coinTasks)}`)
    }
    if (account.error) {
      lines.push(`- 失败原因：${account.error}`)
    }
    if (account.skippedReason) {
      lines.push(`- 跳过原因：${account.skippedReason}`)
    }
    lines.push('')
  }

  return lines.join('\n').trim()
}

function formatCoinTasks(coinTasks: CoinTaskSummary): string {
  const bbsSignin = coinTasks.bbsSignin ? '✓' : '×'
  const share = coinTasks.share.done >= coinTasks.share.target ? '✓' : `${coinTasks.share.done}/${coinTasks.share.target}`
  const todayCoin = typeof coinTasks.coinState?.todayCoin === 'number' ? coinTasks.coinState.todayCoin : undefined
  const limitCoin = typeof coinTasks.coinState?.limitCoin === 'number' ? coinTasks.coinState.limitCoin : undefined
  const coinText = todayCoin === undefined || limitCoin === undefined
    ? ''
    : ` 今日金币${todayCoin}/${limitCoin}`
  return `金币任务：签到${bbsSignin} 浏览${coinTasks.browse.done}/${coinTasks.browse.target} 点赞${coinTasks.like.done}/${coinTasks.like.target} 分享${share}${coinText}`
}

function statusLabel(status: AccountRunSummary['status']): string {
  if (status === 'success') {
    return '成功'
  }
  if (status === 'skipped') {
    return '跳过'
  }
  return '失败'
}

function attendanceStateKey(accountId: string, date: string): string {
  return `attendance:${accountId}:${date}`
}

function shanghaiDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function randomDelay(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1))
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
