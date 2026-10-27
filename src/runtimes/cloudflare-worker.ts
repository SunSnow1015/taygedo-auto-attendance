import { loadRuntimeConfig } from '../config/runtime.js'
import { AttendanceService } from '../services/attendance-service.js'
import { LoginService } from '../services/login-service.js'
import { createCloudflareAccountStore, createCloudflareStateStore } from '../stores/cloudflare-factory.js'
import { CloudflareKvStateStore, type StateStore } from '../stores/state-store.js'
import { cloudflareUserCenterFetch } from './cloudflare-http1.js'
import { TaygedoApi } from '../taygedo/api.js'
import { generateDeviceIdentity } from '../taygedo/device.js'
import type { LoginActionDependencies } from '../login-action.js'
import type { AccountRunSummary, RunAttendanceResult } from '../runner.js'

type ScheduledController = Record<string, unknown>
type ExecutionContext = Record<string, unknown>
type CloudflareRunTrigger = 'scheduled' | 'manual' | 'unknown'
type CloudflareRunOutcome = 'success' | 'partial' | 'failed' | 'skipped' | 'execution-failed'
type CloudflareExecutionStatus = 'completed' | 'failed'

interface PublicAccountRun {
  id: string
  name: string
  status: AccountRunSummary['status']
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
}

interface CloudflareRunStatus {
  startedAt: string
  finishedAt: string
  trigger: CloudflareRunTrigger
  forceRun: boolean
  executionStatus: CloudflareExecutionStatus
  outcome: CloudflareRunOutcome
  totalCount: number
  successCount: number
  failedCount: number
  skippedCount: number
  accounts: PublicAccountRun[]
  notificationErrorCount: number
}

interface CloudflareRunHistoryEntry {
  startedAt: string
  finishedAt: string
  trigger: CloudflareRunTrigger
  forceRun: boolean
  executionStatus: CloudflareExecutionStatus
  outcome: CloudflareRunOutcome
  totalCount: number
  successCount: number
  failedCount: number
  skippedCount: number
  notificationErrorCount: number
}

interface CloudflareStatusEnvelope {
  version: 1
  latest: CloudflareRunStatus
  history: CloudflareRunHistoryEntry[]
}

const CLOUDFLARE_STATUS_KEY = 'worker-status'
const CLOUDFLARE_STATUS_HISTORY_LIMIT = 30

interface CloudflareEnv extends Record<string, unknown> {
  KV: {
    get(key: string): Promise<string | null>
    put(key: string, value: string): Promise<void>
  }
  TAYGEDO_TEST_API?: ConstructorParameters<typeof AttendanceService>[0]['api']
  TAYGEDO_TEST_LOGIN_API?: LoginActionDependencies['api']
}

const worker = {
  async scheduled(_event: ScheduledController, env: CloudflareEnv, _ctx: ExecutionContext): Promise<void> {
    await runCloudflareAttendance(env, { trigger: 'scheduled' })
  },

  async fetch(request: Request, env: CloudflareEnv, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/') {
      return htmlResponse(renderManagementPage())
    }
    if (url.pathname === '/health') {
      return Response.json({ ok: true })
    }
    if (url.pathname !== '/run' && url.pathname !== '/login' && url.pathname !== '/status') {
      return Response.json({ error: '未找到' }, { status: 404 })
    }

    const adminToken = typeof env.TAYGEDO_ADMIN_TOKEN === 'string' ? env.TAYGEDO_ADMIN_TOKEN.trim() : ''
    if (!adminToken) {
      return noStoreJson({ error: '请先配置 TAYGEDO_ADMIN_TOKEN 才能使用管理接口。' }, 503)
    }
    if (!constantTimeTokenMatches(`Bearer ${adminToken}`, request.headers.get('Authorization'))) {
      return noStoreJson({ error: '未授权' }, 401)
    }

    try {
      if (url.pathname === '/login') {
        const result = await runCloudflareLogin(request, env)
        return Response.json({ ok: true, ...result })
      }
      if (url.pathname === '/status') {
        if (request.method !== 'GET') {
          throw new HttpError(405, 'Cloudflare 状态接口必须使用 GET')
        }
        const status = await readCloudflareStatus(env)
        return noStoreJson({ ok: true, ...status })
      }
      if (url.pathname === '/run') {
        const result = await runCloudflareAttendance(env, {
          forceRun: isForceRunRequest(url),
          trigger: 'manual',
        })
        return noStoreJson({
          ok: true,
          summary: result.summary,
          forceRun: result.forceRun,
        })
      }
    }
    catch (error) {
      if (error instanceof HttpError) {
        return noStoreJson({ error: error.message }, error.status)
      }
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[taygedo-worker] path=${url.pathname} ${message}`)
      return noStoreJson({
        error: message,
      }, 502)
    }

    return Response.json({ error: '未找到' }, { status: 404 })
  },
}

export default worker

function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function noStoreJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
    },
  })
}

function renderManagementPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>塔吉多签到管理</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f4;
      --panel: #ffffff;
      --ink: #17211b;
      --muted: #647067;
      --line: #d9ded8;
      --accent: #16735f;
      --accent-dark: #0f5b4b;
      --danger: #a43b3b;
      --ok: #1f7a45;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--ink);
      font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(760px, calc(100% - 32px));
      margin: 0 auto;
      padding: 28px 0 40px;
    }
    header {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 16px;
      padding-bottom: 18px;
      border-bottom: 1px solid var(--line);
    }
    h1 { margin: 0; font-size: clamp(24px, 4vw, 34px); letter-spacing: 0; }
    h2 { margin: 0 0 12px; font-size: 18px; letter-spacing: 0; }
    h3 { margin: 18px 0 10px; font-size: 15px; }
    p { margin: 6px 0 0; color: var(--muted); }
    button, input, textarea {
      font: inherit;
      border-radius: 7px;
      border: 1px solid var(--line);
    }
    button {
      min-height: 44px;
      padding: 0 13px;
      border-color: var(--accent);
      background: var(--accent);
      color: white;
      cursor: pointer;
    }
    button.secondary { background: white; color: var(--accent-dark); border-color: var(--line); }
    button:disabled { opacity: .55; cursor: not-allowed; }
    input, select {
      width: 100%;
      background: white;
      color: var(--ink);
      padding: 9px 10px;
    }
    label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 13px;
    }
    label span { color: var(--muted); }
    .fields {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }
    section {
      margin-top: 20px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
    }
    .toolbar {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
      margin-top: 14px;
    }
    .section-heading {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 14px;
    }
    .section-heading h2 { margin-bottom: 2px; }
    .section-heading p { margin-top: 2px; }
    .status-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-top: 14px;
    }
    .metric {
      display: grid;
      gap: 5px;
      min-height: 76px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #fafbf9;
    }
    .metric span { color: var(--muted); font-size: 12px; }
    .metric strong { font-size: 16px; overflow-wrap: anywhere; }
    .status-badge {
      display: inline-flex;
      align-items: center;
      width: fit-content;
      min-height: 26px;
      padding: 2px 9px;
      border-radius: 999px;
      background: #edf1ee;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .status-badge.success, .status-badge.skipped { background: #e8f5ed; color: var(--ok); }
    .status-badge.partial { background: #fff4d8; color: #8a5b00; }
    .status-badge.failed { background: #faeaea; color: var(--danger); }
    .account-list, .history-list { display: grid; gap: 10px; }
    .account-item, .history-item {
      display: grid;
      gap: 8px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #fafbf9;
    }
    .item-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .item-heading strong { overflow-wrap: anywhere; }
    .item-meta { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
    .detail-list { display: grid; gap: 4px; color: var(--muted); font-size: 13px; }
    .stack { display: grid; gap: 14px; }
    .result {
      min-height: 54px;
      margin-top: 14px;
      padding: 10px 12px;
      border-radius: 7px;
      background: #f0f4f1;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: var(--muted);
    }
    .ok { color: var(--ok); }
    .error { color: var(--danger); }
    .hidden { display: none; }
    @media (max-width: 820px) {
      main { width: min(100% - 20px, 640px); padding-top: 18px; }
      header { align-items: start; flex-direction: column; }
      .fields { grid-template-columns: 1fr; }
      .status-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .section-heading { align-items: stretch; flex-direction: column; }
      .section-heading button { width: 100%; }
      section { padding: 14px; }
    }
    @media (max-width: 460px) {
      .status-grid { grid-template-columns: 1fr; }
      .item-heading { align-items: start; flex-direction: column; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>塔吉多签到管理</h1>
        <p>查看定时签到状态，并通过 Cloudflare Worker 管理登录账号。</p>
      </div>
    </header>

    <section>
      <h2>账号登录</h2>
      <form id="login-form" class="stack">
        <div class="fields">
          <label><span>管理员 Token</span><input id="token" type="password" autocomplete="current-password" required></label>
          <label><span>登录方式</span>
            <select id="mode" name="mode">
              <option value="password">账号密码登录</option>
              <option value="captcha">短信验证码登录</option>
            </select>
          </label>
          <label><span>手机号</span><input id="phone" name="phone" inputmode="tel" autocomplete="tel" required></label>
          <label class="password-field"><span>密码</span><input id="password" name="password" type="password" autocomplete="current-password"></label>
          <label class="captcha-field hidden"><span>短信验证码</span><input id="captcha" name="captcha" inputmode="numeric" autocomplete="one-time-code"></label>
          <label><span>账号 ID</span><input id="account-id" name="accountId" value="main"></label>
          <label><span>账号名称</span><input id="account-name" name="accountName" value="主账号"></label>
        </div>
        <div class="toolbar">
          <button id="submit" type="submit">账号密码登录</button>
          <button id="remember" class="secondary" type="button">记住 Token</button>
        </div>
      </form>
      <div id="result" class="result">请选择登录模式后提交。</div>
    </section>

    <section aria-labelledby="status-title">
      <div class="section-heading">
        <div>
          <h2 id="status-title">最近签到</h2>
          <p>状态来自 Worker 的受保护运行记录，不会返回账号 Token 或通知地址。</p>
        </div>
        <button id="refresh-status" class="secondary" type="button">刷新状态</button>
      </div>
      <div id="status-message" class="result">填写上方管理员 Token 后即可查看。</div>
      <div id="status-content" class="hidden">
        <div class="status-grid">
          <div class="metric"><span>执行结果</span><strong id="status-outcome">暂无</strong></div>
          <div class="metric"><span>完成时间</span><strong id="status-time">暂无</strong></div>
          <div class="metric"><span>触发方式</span><strong id="status-trigger">暂无</strong></div>
          <div class="metric"><span>账号统计</span><strong id="status-counts">暂无</strong></div>
        </div>
        <h3>本次明细</h3>
        <div id="status-accounts" class="account-list"></div>
        <h3>最近 30 次执行</h3>
        <div id="status-history" class="history-list"></div>
      </div>
    </section>
  </main>

  <script>
    const form = document.querySelector('#login-form')
    const modeInput = document.querySelector('#mode')
    const tokenInput = document.querySelector('#token')
    const phoneInput = document.querySelector('#phone')
    const captchaInput = document.querySelector('#captcha')
    const submitButton = document.querySelector('#submit')
    const result = document.querySelector('#result')
    const refreshStatusButton = document.querySelector('#refresh-status')
    const statusMessage = document.querySelector('#status-message')
    const statusContent = document.querySelector('#status-content')
    const statusOutcome = document.querySelector('#status-outcome')
    const statusTime = document.querySelector('#status-time')
    const statusTrigger = document.querySelector('#status-trigger')
    const statusCounts = document.querySelector('#status-counts')
    const statusAccounts = document.querySelector('#status-accounts')
    const statusHistory = document.querySelector('#status-history')
    const captchaSessionKey = 'taygedoCaptchaSession'
    const captchaSessionTtlMs = 10 * 60 * 1000
    const captchaResendSeconds = 60
    let captchaDeviceId = ''
    let captchaPhone = ''
    let captchaSentAt = 0
    let resendTimer = 0
    let captchaExpiryTimer = 0
    let resendRemaining = 0
    let sendingCaptcha = false
    try {
      tokenInput.value = localStorage.getItem('taygedoAdminToken') || ''
    } catch {
      tokenInput.value = ''
    }

    function syncMode() {
      const mode = modeInput.value
      const captchaMode = mode === 'captcha'
      document.querySelector('.password-field').classList.toggle('hidden', captchaMode)
      document.querySelector('.captcha-field').classList.toggle('hidden', !captchaMode)
      document.querySelector('#password').required = !captchaMode
      captchaInput.required = false
      syncSubmitButton()
    }

    function clearStoredCaptchaSession() {
      try {
        sessionStorage.removeItem(captchaSessionKey)
      } catch {}
    }

    function resetCaptchaSession() {
      captchaDeviceId = ''
      captchaPhone = ''
      captchaSentAt = 0
      resendRemaining = 0
      if (resendTimer) window.clearInterval(resendTimer)
      if (captchaExpiryTimer) window.clearTimeout(captchaExpiryTimer)
      resendTimer = 0
      captchaExpiryTimer = 0
      clearStoredCaptchaSession()
    }

    function hasCaptchaSession() {
      if (!captchaDeviceId || captchaPhone !== phoneInput.value.trim()) return false
      const age = Date.now() - captchaSentAt
      if (!captchaSentAt || age < 0 || age >= captchaSessionTtlMs) {
        resetCaptchaSession()
        return false
      }
      return true
    }

    function syncSubmitButton() {
      if (modeInput.value !== 'captcha') {
        submitButton.textContent = '账号密码登录'
        return
      }
      if (sendingCaptcha) {
        submitButton.textContent = '正在发送验证码...'
        return
      }
      if (!hasCaptchaSession()) {
        submitButton.textContent = '发送验证码'
        return
      }
      submitButton.textContent = !captchaInput.value.trim() && resendRemaining <= 0
        ? '重新发送验证码'
        : '验证码登录'
    }

    function startResendCooldown(seconds) {
      if (resendTimer) window.clearInterval(resendTimer)
      resendRemaining = seconds
      syncSubmitButton()
      resendTimer = window.setInterval(() => {
        resendRemaining -= 1
        if (resendRemaining <= 0) {
          window.clearInterval(resendTimer)
          resendTimer = 0
          resendRemaining = 0
        }
        syncSubmitButton()
      }, 1000)
    }

    function scheduleCaptchaExpiry() {
      if (captchaExpiryTimer) window.clearTimeout(captchaExpiryTimer)
      const remaining = captchaSentAt + captchaSessionTtlMs - Date.now()
      if (remaining <= 0) {
        resetCaptchaSession()
        return
      }
      captchaExpiryTimer = window.setTimeout(() => {
        resetCaptchaSession()
        result.className = 'result error'
        result.textContent = '验证码已过期，请重新发送。'
        syncSubmitButton()
      }, remaining)
    }

    function persistCaptchaSession() {
      try {
        sessionStorage.setItem(captchaSessionKey, JSON.stringify({
          deviceId: captchaDeviceId,
          phone: captchaPhone,
          sentAt: captchaSentAt,
        }))
      } catch {}
      scheduleCaptchaExpiry()
    }

    function restoreCaptchaSession() {
      let stored = ''
      try {
        stored = sessionStorage.getItem(captchaSessionKey) || ''
      } catch {}
      if (!stored) return false

      try {
        const parsed = JSON.parse(stored)
        const deviceId = typeof parsed.deviceId === 'string' ? parsed.deviceId : ''
        const phone = typeof parsed.phone === 'string' ? parsed.phone : ''
        const sentAt = Number(parsed.sentAt)
        const age = Date.now() - sentAt
        if (!deviceId || !phone || !Number.isFinite(sentAt) || age < 0 || age >= captchaSessionTtlMs) {
          clearStoredCaptchaSession()
          return false
        }

        captchaDeviceId = deviceId
        captchaPhone = phone
        captchaSentAt = sentAt
        phoneInput.value = phone
        modeInput.value = 'captcha'
        const cooldownRemaining = Math.ceil((sentAt + captchaResendSeconds * 1000 - Date.now()) / 1000)
        if (cooldownRemaining > 0) startResendCooldown(cooldownRemaining)
        scheduleCaptchaExpiry()
        result.className = 'result ok'
        result.textContent = '已恢复刚才发送的验证码，可继续填写并登录。'
        return true
      } catch {
        clearStoredCaptchaSession()
        return false
      }
    }

    function payloadFromForm(modeOverride) {
      const data = new FormData(form)
      const uiMode = String(data.get('mode') || 'password')
      const mode = modeOverride || (uiMode === 'captcha' ? 'login' : 'password')
      const payload = {
        mode,
        phone: String(data.get('phone') || '').trim(),
        accountId: String(data.get('accountId') || 'main').trim() || 'main',
        accountName: String(data.get('accountName') || '').trim() || '主账号',
      }
      const password = String(data.get('password') || '')
      const captcha = String(data.get('captcha') || '').trim()
      if (mode === 'password') payload.password = password
      if (mode === 'login') {
        payload.captcha = captcha
        payload.deviceId = captchaDeviceId || undefined
      }
      return payload
    }

    async function requestLogin(payload) {
      const response = await fetch('/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: 'Bearer ' + tokenInput.value.trim(),
        },
        body: JSON.stringify(payload),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'HTTP 状态码 ' + response.status)
      return data
    }

    async function loadStatus() {
      const token = tokenInput.value.trim()
      if (!token) {
        statusContent.classList.add('hidden')
        showStatusMessage('填写上方管理员 Token 后即可查看。', '')
        return
      }
      refreshStatusButton.disabled = true
      showStatusMessage('正在读取签到状态...', '')
      try {
        const response = await fetch('/status', {
          method: 'GET',
          cache: 'no-store',
          headers: { Authorization: 'Bearer ' + token },
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || 'HTTP 状态码 ' + response.status)
        renderStatus(data)
      } catch (error) {
        statusContent.classList.add('hidden')
        showStatusMessage(error.message, 'error')
      } finally {
        refreshStatusButton.disabled = false
      }
    }

    function showStatusMessage(message, className) {
      statusMessage.className = 'result' + (className ? ' ' + className : '')
      statusMessage.textContent = message
      statusMessage.classList.remove('hidden')
    }

    function renderStatus(data) {
      const latest = data.latest
      if (!latest) {
        statusContent.classList.add('hidden')
        showStatusMessage('还没有签到执行记录。定时任务首次运行后会显示在这里。', '')
        return
      }

      statusMessage.classList.add('hidden')
      statusContent.classList.remove('hidden')
      statusOutcome.textContent = outcomeLabel(latest.outcome)
      statusOutcome.className = outcomeClassName(latest.outcome)
      statusTime.textContent = formatShanghaiTime(latest.finishedAt)
      statusTrigger.textContent = triggerLabel(latest.trigger) + (latest.forceRun ? '（强制）' : '')
      statusCounts.textContent = '成功 ' + latest.successCount + ' / 失败 ' + latest.failedCount + ' / 跳过 ' + latest.skippedCount
      renderAccounts(Array.isArray(latest.accounts) ? latest.accounts : [], latest.executionStatus)
      renderHistory(Array.isArray(data.history) ? data.history : [])
    }

    function renderAccounts(accounts, executionStatus) {
      statusAccounts.replaceChildren()
      if (executionStatus === 'failed') {
        statusAccounts.append(createTextBlock('Worker 执行失败，具体原因请查看 Cloudflare Observability Logs。', 'item-meta'))
        return
      }
      if (!accounts.length) {
        statusAccounts.append(createTextBlock('本次没有账号明细。', 'item-meta'))
        return
      }

      for (const account of accounts) {
        const item = document.createElement('article')
        item.className = 'account-item'
        const heading = document.createElement('div')
        heading.className = 'item-heading'
        heading.append(createTextBlock((account.name || '未命名账号') + '（' + (account.id || 'unknown') + '）', ''))
        const badge = createTextBlock(accountStatusLabel(account.status), 'status-badge ' + accountStatusClass(account.status))
        heading.append(badge)
        item.append(heading)

        const details = document.createElement('div')
        details.className = 'detail-list'
        if (account.appSignin) {
          const appText = account.appSignin.alreadySigned
            ? 'APP：今日已签到'
            : 'APP：签到成功' + rewardText(account.appSignin)
          details.append(createTextBlock(appText, ''))
        }
        for (const game of account.gameSignins || []) {
          const gameText = '游戏 ' + (game.gameId || 'unknown') + ' / ' + (game.roleName || '未命名角色') + '：'
            + (game.alreadySigned ? '今日已签到' : '签到成功')
            + (game.days === undefined ? '' : '，本月第 ' + game.days + ' 天')
            + (game.reward ? '，奖励 ' + game.reward.name + ' x' + game.reward.num : '')
          details.append(createTextBlock(gameText, ''))
        }
        if (account.status === 'failed') {
          details.append(createTextBlock('账号执行失败，具体原因请查看 Worker Logs。', 'error'))
        }
        if (!details.childNodes.length) {
          details.append(createTextBlock(account.status === 'skipped' ? '今天已有成功记录，本次已跳过。' : '本次执行完成。', ''))
        }
        item.append(details)
        statusAccounts.append(item)
      }
    }

    function renderHistory(history) {
      statusHistory.replaceChildren()
      if (!history.length) {
        statusHistory.append(createTextBlock('暂无历史记录。', 'item-meta'))
        return
      }
      for (const run of history) {
        const item = document.createElement('article')
        item.className = 'history-item'
        const heading = document.createElement('div')
        heading.className = 'item-heading'
        heading.append(createTextBlock(formatShanghaiTime(run.finishedAt), ''))
        heading.append(createTextBlock(outcomeLabel(run.outcome), outcomeClassName(run.outcome)))
        item.append(heading)
        const trigger = triggerLabel(run.trigger) + (run.forceRun ? '（强制）' : '')
        item.append(createTextBlock(
          trigger + ' · 成功 ' + run.successCount + ' · 失败 ' + run.failedCount + ' · 跳过 ' + run.skippedCount,
          'item-meta',
        ))
        if (run.notificationErrorCount > 0) {
          item.append(createTextBlock('签到已完成，但有 ' + run.notificationErrorCount + ' 个通知发送失败。', 'item-meta'))
        }
        statusHistory.append(item)
      }
    }

    function createTextBlock(text, className) {
      const element = document.createElement('span')
      element.textContent = text
      if (className) element.className = className
      return element
    }

    function rewardText(appSignin) {
      const rewards = []
      if (appSignin.goldCoin !== undefined) rewards.push(appSignin.goldCoin + ' 金币')
      if (appSignin.exp !== undefined) rewards.push(appSignin.exp + ' 经验')
      return rewards.length ? '，获得 ' + rewards.join('、') : ''
    }

    function formatShanghaiTime(value) {
      const date = new Date(value)
      if (!value || Number.isNaN(date.getTime())) return '未知时间'
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(date)
    }

    function triggerLabel(trigger) {
      if (trigger === 'scheduled') return '定时任务'
      if (trigger === 'manual') return '手动运行'
      return '来源未记录'
    }

    function outcomeLabel(outcome) {
      if (outcome === 'partial') return '部分失败'
      if (outcome === 'failed' || outcome === 'execution-failed') return '执行失败'
      if (outcome === 'skipped') return '今日已完成'
      return '全部成功'
    }

    function outcomeClassName(outcome) {
      if (outcome === 'partial') return 'status-badge partial'
      if (outcome === 'failed' || outcome === 'execution-failed') return 'status-badge failed'
      if (outcome === 'skipped') return 'status-badge skipped'
      return 'status-badge success'
    }

    function accountStatusLabel(status) {
      if (status === 'failed') return '失败'
      if (status === 'skipped') return '已跳过'
      return '成功'
    }

    function accountStatusClass(status) {
      if (status === 'failed') return 'failed'
      if (status === 'skipped') return 'skipped'
      return 'success'
    }

    async function sendCaptcha() {
      const requestedPhone = phoneInput.value.trim()
      result.className = 'result'
      result.textContent = '正在发送验证码...'
      sendingCaptcha = true
      submitButton.disabled = true
      syncSubmitButton()
      try {
        const payload = payloadFromForm('send-code')
        const data = await requestLogin(payload)
        if (!data.deviceId) throw new Error('发送验证码后未返回设备信息，请重试。')
        captchaDeviceId = data.deviceId
        captchaPhone = payload.phone
        captchaSentAt = Date.now()
        persistCaptchaSession()
        result.className = 'result ok'
        result.textContent = '验证码已发送，请在上方填写短信验证码并登录。'
        startResendCooldown(captchaResendSeconds)
        captchaInput.focus()
      } catch (error) {
        const hasUsableSession = Boolean(captchaDeviceId && captchaPhone === requestedPhone)
        if (!hasUsableSession) resetCaptchaSession()
        result.className = 'result error'
        result.textContent = error.message + (hasUsableSession ? '；刚才成功发送的验证码仍可继续登录。' : '')
      } finally {
        sendingCaptcha = false
        submitButton.disabled = false
        syncSubmitButton()
      }
    }

    async function submitLogin(event) {
      event.preventDefault()
      if (modeInput.value === 'captcha') {
        if (!hasCaptchaSession()) {
          await sendCaptcha()
          return
        }
        if (!captchaInput.value.trim()) {
          if (resendRemaining <= 0) {
            await sendCaptcha()
            return
          }
          result.className = 'result error'
          result.textContent = '请输入短信验证码；' + resendRemaining + ' 秒后可重新发送。'
          captchaInput.focus()
          return
        }
      }
      result.className = 'result'
      result.textContent = '正在提交...'
      submitButton.disabled = true
      try {
        await requestLogin(payloadFromForm())
        resetCaptchaSession()
        result.className = 'result ok'
        result.textContent = '登录成功，账号已写入 KV。'
      } catch (error) {
        result.className = 'result error'
        result.textContent = error.message
      } finally {
        submitButton.disabled = false
        syncSubmitButton()
      }
    }

    document.querySelector('#remember').addEventListener('click', () => {
      try {
        localStorage.setItem('taygedoAdminToken', tokenInput.value)
        result.className = 'result ok'
        result.textContent = 'Token 已保存在当前浏览器。'
      } catch {
        result.className = 'result error'
        result.textContent = '浏览器禁止本地存储，Token 未保存，但当前页面仍可使用。'
      }
      void loadStatus()
    })
    modeInput.addEventListener('change', () => {
      resetCaptchaSession()
      captchaInput.value = ''
      syncMode()
    })
    phoneInput.addEventListener('input', () => {
      if (captchaPhone && captchaPhone !== phoneInput.value.trim()) {
        resetCaptchaSession()
      }
      syncSubmitButton()
    })
    captchaInput.addEventListener('input', syncSubmitButton)
    refreshStatusButton.addEventListener('click', loadStatus)
    form.addEventListener('submit', submitLogin)
    restoreCaptchaSession()
    syncMode()
    if (tokenInput.value.trim()) void loadStatus()
  </script>
</body>
</html>`
}

async function runCloudflareAttendance(
  env: CloudflareEnv,
  options: { forceRun?: boolean, trigger: Exclude<CloudflareRunTrigger, 'unknown'> },
) {
  const statusStore = createCloudflareStatusStore(env)
  const startedAt = new Date().toISOString()
  let forceRun = options.forceRun ?? false
  try {
    const config = loadRuntimeConfig(envToStrings(env))
    forceRun = options.forceRun ?? config.forceRun
    const service = new AttendanceService({
      accountStore: createCloudflareAccountStore({ config, kv: env.KV }),
      stateStore: createCloudflareStateStore({ config, kv: env.KV }),
      api: env.TAYGEDO_TEST_API ?? createCloudflareTaygedoApi(),
      accountPasswords: config.accountPasswords,
      credentialKey: config.credentialKey,
      notificationUrls: config.notificationUrls,
      maxRetries: config.maxRetries,
      accountConcurrency: config.accountConcurrency,
      forceRun,
      coinTasks: config.coinTasks,
      cloudDuration: config.cloudDuration,
      sharePlatform: config.sharePlatform,
    })
    const result = await service.run()
    await persistCloudflareStatus(statusStore, statusFromRunResult(result, options.trigger))
    return result
  }
  catch (error) {
    await persistCloudflareStatus(statusStore, {
      startedAt,
      finishedAt: new Date().toISOString(),
      trigger: options.trigger,
      forceRun,
      executionStatus: 'failed',
      outcome: 'execution-failed',
      totalCount: 0,
      successCount: 0,
      failedCount: 0,
      skippedCount: 0,
      accounts: [],
      notificationErrorCount: 0,
    })
    throw error
  }
}

function createCloudflareStatusStore(env: CloudflareEnv): StateStore {
  const configuredPrefix = typeof env.TAYGEDO_STATE_PREFIX === 'string'
    ? env.TAYGEDO_STATE_PREFIX.trim()
    : ''
  return new CloudflareKvStateStore(env.KV, configuredPrefix || 'taygedo')
}

async function readCloudflareStatus(env: CloudflareEnv): Promise<{
  latest: CloudflareRunStatus | null
  history: CloudflareRunHistoryEntry[]
}> {
  const stateStore = createCloudflareStatusStore(env)
  let envelope: CloudflareStatusEnvelope | undefined
  try {
    const stored = await stateStore.get<unknown>(CLOUDFLARE_STATUS_KEY)
    envelope = sanitizeStatusEnvelope(stored)
  }
  catch {
    console.warn(JSON.stringify({ component: 'taygedo-status', message: 'stored Worker status is unreadable' }))
  }

  let legacyLatest: CloudflareRunStatus | null = null
  try {
    const legacy = await stateStore.get<unknown>('last-run')
    legacyLatest = statusFromLegacyRun(legacy)
  }
  catch {
    console.warn(JSON.stringify({ component: 'taygedo-status', message: 'legacy last-run is unreadable' }))
  }

  if (!envelope && !legacyLatest) {
    return { latest: null, history: [] }
  }
  if (!envelope && legacyLatest) {
    return {
      latest: legacyLatest,
      history: [historyEntryFromStatus(legacyLatest)],
    }
  }
  if (envelope && !legacyLatest) {
    return {
      latest: envelope.latest,
      history: envelope.history,
    }
  }

  const storedLatest = envelope!.latest
  const latest = isStatusNewer(legacyLatest!, storedLatest) ? legacyLatest! : storedLatest
  return {
    latest,
    history: mergeHistoryEntries([
      historyEntryFromStatus(storedLatest),
      historyEntryFromStatus(legacyLatest!),
      ...envelope!.history,
    ]),
  }
}

async function persistCloudflareStatus(stateStore: StateStore, latest: CloudflareRunStatus): Promise<void> {
  let previousEnvelope: CloudflareStatusEnvelope | undefined
  try {
    const stored = await stateStore.get<unknown>(CLOUDFLARE_STATUS_KEY)
    previousEnvelope = sanitizeStatusEnvelope(stored)
  }
  catch {
    console.warn(JSON.stringify({ component: 'taygedo-status', message: 'existing history is unreadable' }))
  }

  const envelopeLatest = previousEnvelope && isStatusNewer(previousEnvelope.latest, latest)
    ? previousEnvelope.latest
    : latest
  const history = mergeHistoryEntries([
    historyEntryFromStatus(latest),
    ...(previousEnvelope ? [historyEntryFromStatus(previousEnvelope.latest), ...previousEnvelope.history] : []),
  ])
  try {
    await stateStore.set(CLOUDFLARE_STATUS_KEY, {
      version: 1,
      latest: envelopeLatest,
      history,
    } satisfies CloudflareStatusEnvelope)
  }
  catch {
    console.error(JSON.stringify({ component: 'taygedo-status', message: 'failed to persist Worker status' }))
  }
}

function statusFromRunResult(result: RunAttendanceResult, trigger: CloudflareRunTrigger): CloudflareRunStatus {
  const totalCount = result.accounts.length
  return {
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    trigger,
    forceRun: result.forceRun,
    executionStatus: 'completed',
    outcome: deriveRunOutcome('completed', totalCount, result.successCount, result.failedCount, result.skippedCount),
    totalCount,
    successCount: result.successCount,
    failedCount: result.failedCount,
    skippedCount: result.skippedCount,
    accounts: result.accounts.map(publicAccountFromSummary),
    notificationErrorCount: result.notificationErrors.length,
  }
}

function publicAccountFromSummary(account: AccountRunSummary): PublicAccountRun {
  return {
    id: account.id,
    name: account.name,
    status: account.status,
    ...(account.appSignin
      ? {
          appSignin: {
            ...(account.appSignin.alreadySigned !== undefined ? { alreadySigned: account.appSignin.alreadySigned } : {}),
            ...(account.appSignin.exp !== undefined ? { exp: account.appSignin.exp } : {}),
            ...(account.appSignin.goldCoin !== undefined ? { goldCoin: account.appSignin.goldCoin } : {}),
          },
        }
      : {}),
    gameSignins: account.gameSignins.map(game => ({
      gameId: game.gameId,
      roleName: game.roleName,
      ...(game.days !== undefined ? { days: game.days } : {}),
      ...(game.reward ? { reward: { name: game.reward.name, num: game.reward.num } } : {}),
      ...(game.alreadySigned !== undefined ? { alreadySigned: game.alreadySigned } : {}),
      success: game.success,
    })),
  }
}

function historyEntryFromStatus(status: CloudflareRunStatus): CloudflareRunHistoryEntry {
  return {
    startedAt: status.startedAt,
    finishedAt: status.finishedAt,
    trigger: status.trigger,
    forceRun: status.forceRun,
    executionStatus: status.executionStatus,
    outcome: status.outcome,
    totalCount: status.totalCount,
    successCount: status.successCount,
    failedCount: status.failedCount,
    skippedCount: status.skippedCount,
    notificationErrorCount: status.notificationErrorCount,
  }
}

function isStatusNewer(candidate: CloudflareRunStatus, current: CloudflareRunStatus): boolean {
  return Date.parse(candidate.finishedAt) > Date.parse(current.finishedAt)
}

function mergeHistoryEntries(entries: CloudflareRunHistoryEntry[]): CloudflareRunHistoryEntry[] {
  const sorted = [...entries].sort((left, right) => {
    const timeDifference = Date.parse(right.finishedAt) - Date.parse(left.finishedAt)
    if (timeDifference !== 0) {
      return timeDifference
    }
    return Number(right.trigger !== 'unknown') - Number(left.trigger !== 'unknown')
  })
  const seen = new Set<string>()
  return sorted.filter((entry) => {
    const runKey = `${entry.startedAt}\u0000${entry.finishedAt}`
    if (seen.has(runKey)) {
      return false
    }
    seen.add(runKey)
    return true
  }).slice(0, CLOUDFLARE_STATUS_HISTORY_LIMIT)
}

function sanitizeStatusEnvelope(value: unknown): CloudflareStatusEnvelope | undefined {
  if (!isRecord(value) || value.version !== 1) {
    return undefined
  }
  const latest = sanitizeRunStatus(value.latest)
  if (!latest) {
    return undefined
  }
  const storedHistory = Array.isArray(value.history)
    ? value.history.flatMap(item => {
        const entry = sanitizeHistoryEntry(item)
        return entry ? [entry] : []
      })
    : []
  const history = mergeHistoryEntries([historyEntryFromStatus(latest), ...storedHistory])
  return { version: 1, latest, history }
}

function sanitizeRunStatus(value: unknown): CloudflareRunStatus | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  if (value.executionStatus !== 'completed' && value.executionStatus !== 'failed') {
    return undefined
  }
  const startedAt = safeTimestamp(value.startedAt)
  const finishedAt = safeTimestamp(value.finishedAt)
  if (!startedAt || !finishedAt) {
    return undefined
  }
  const executionStatus = value.executionStatus
  const successCount = safeCount(value.successCount)
  const failedCount = safeCount(value.failedCount)
  const skippedCount = safeCount(value.skippedCount)
  const accounts = Array.isArray(value.accounts)
    ? value.accounts.flatMap(item => {
        const account = sanitizePublicAccount(item)
        return account ? [account] : []
      })
    : []
  const totalCount = safeCount(value.totalCount, accounts.length)
  return {
    startedAt,
    finishedAt,
    trigger: sanitizeRunTrigger(value.trigger),
    forceRun: value.forceRun === true,
    executionStatus,
    outcome: deriveRunOutcome(executionStatus, totalCount, successCount, failedCount, skippedCount),
    totalCount,
    successCount,
    failedCount,
    skippedCount,
    accounts,
    notificationErrorCount: safeCount(value.notificationErrorCount),
  }
}

function sanitizeHistoryEntry(value: unknown): CloudflareRunHistoryEntry | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  if (value.executionStatus !== 'completed' && value.executionStatus !== 'failed') {
    return undefined
  }
  const startedAt = safeTimestamp(value.startedAt)
  const finishedAt = safeTimestamp(value.finishedAt)
  if (!startedAt || !finishedAt) {
    return undefined
  }
  const executionStatus = value.executionStatus
  const successCount = safeCount(value.successCount)
  const failedCount = safeCount(value.failedCount)
  const skippedCount = safeCount(value.skippedCount)
  const totalCount = safeCount(value.totalCount)
  return {
    startedAt,
    finishedAt,
    trigger: sanitizeRunTrigger(value.trigger),
    forceRun: value.forceRun === true,
    executionStatus,
    outcome: deriveRunOutcome(executionStatus, totalCount, successCount, failedCount, skippedCount),
    totalCount,
    successCount,
    failedCount,
    skippedCount,
    notificationErrorCount: safeCount(value.notificationErrorCount),
  }
}

function statusFromLegacyRun(value: unknown): CloudflareRunStatus | null {
  if (!isRecord(value)) {
    return null
  }
  const startedAt = safeTimestamp(value.startedAt)
  const finishedAt = safeTimestamp(value.finishedAt)
  if (!startedAt || !finishedAt) {
    return null
  }
  const accounts = Array.isArray(value.accounts)
    ? value.accounts.flatMap(item => {
        const account = sanitizePublicAccount(item)
        return account ? [account] : []
      })
    : []
  const successCount = safeCount(value.successCount)
  const failedCount = safeCount(value.failedCount)
  const skippedCount = safeCount(value.skippedCount)
  const totalCount = safeCount(value.totalCount, accounts.length)
  return {
    startedAt,
    finishedAt,
    trigger: 'unknown',
    forceRun: value.forceRun === true,
    executionStatus: 'completed',
    outcome: deriveRunOutcome('completed', totalCount, successCount, failedCount, skippedCount),
    totalCount,
    successCount,
    failedCount,
    skippedCount,
    accounts,
    notificationErrorCount: Array.isArray(value.notificationErrors) ? value.notificationErrors.length : 0,
  }
}

function sanitizePublicAccount(value: unknown): PublicAccountRun | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  if (value.status !== 'success' && value.status !== 'failed' && value.status !== 'skipped') {
    return undefined
  }
  const status = value.status
  const appSignin = isRecord(value.appSignin)
    ? {
        ...(typeof value.appSignin.alreadySigned === 'boolean' ? { alreadySigned: value.appSignin.alreadySigned } : {}),
        ...(typeof value.appSignin.exp === 'number' && Number.isFinite(value.appSignin.exp) ? { exp: value.appSignin.exp } : {}),
        ...(typeof value.appSignin.goldCoin === 'number' && Number.isFinite(value.appSignin.goldCoin) ? { goldCoin: value.appSignin.goldCoin } : {}),
      }
    : undefined
  const gameSignins = Array.isArray(value.gameSignins)
    ? value.gameSignins.flatMap(item => {
        if (!isRecord(item)) {
          return []
        }
        const reward = isRecord(item.reward)
          ? {
              name: safeText(item.reward.name),
              num: safeCount(item.reward.num),
            }
          : undefined
        return [{
          gameId: safeText(item.gameId),
          roleName: safeText(item.roleName),
          ...(typeof item.days === 'number' && Number.isFinite(item.days) ? { days: item.days } : {}),
          ...(reward ? { reward } : {}),
          ...(typeof item.alreadySigned === 'boolean' ? { alreadySigned: item.alreadySigned } : {}),
          success: item.success === true,
        }]
      })
    : []
  return {
    id: safeText(value.id),
    name: safeText(value.name),
    status,
    ...(appSignin ? { appSignin } : {}),
    gameSignins,
  }
}

function deriveRunOutcome(
  executionStatus: CloudflareExecutionStatus,
  totalCount: number,
  successCount: number,
  failedCount: number,
  skippedCount: number,
): CloudflareRunOutcome {
  if (executionStatus === 'failed') {
    return 'execution-failed'
  }
  if (totalCount === 0) {
    return 'failed'
  }
  if (successCount + failedCount + skippedCount !== totalCount) {
    return 'failed'
  }
  if (failedCount > 0) {
    return successCount + skippedCount > 0 ? 'partial' : 'failed'
  }
  if (successCount === 0 && skippedCount > 0) {
    return 'skipped'
  }
  return 'success'
}

function sanitizeRunTrigger(value: unknown): CloudflareRunTrigger {
  return value === 'scheduled' || value === 'manual' ? value : 'unknown'
}

function safeCount(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function safeTimestamp(value: unknown): string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : ''
}

function safeText(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 160) : ''
}

function isForceRunRequest(url: URL): boolean {
  const value = url.searchParams.get('force')
  return value === '1' || value === 'true'
}

async function runCloudflareLogin(request: Request, env: CloudflareEnv) {
  const config = loadRuntimeConfig(envToStrings(env))
  const body = await readLoginBody(request)
  const mode = body.mode ?? 'password'
  if (mode === 'password' && body.password && !config.credentialKey) {
    throw new HttpError(400, '缺少 TAYGEDO_CREDENTIAL_KEY，请先在 Cloudflare 中添加 Secret。')
  }
  const currentAccounts = await tryReadCloudflareAccounts(env, config.accountsKey, config.accountsSecret)
  const service = new LoginService({
    api: env.TAYGEDO_TEST_LOGIN_API ?? createCloudflareTaygedoApi(),
    onStage: (stage, details) => {
      console.info(`[taygedo-login] stage=${stage} ${JSON.stringify(details)}`)
    },
  })
  const deviceId = body.deviceId ?? (mode === 'send-code' ? generateDeviceIdentity().deviceId : undefined)
  await service.runLogin({
    mode,
    phone: body.phone,
    password: body.password,
    captcha: body.captcha,
    deviceId,
    newDevice: body.newDevice,
    accountId: body.accountId ?? 'main',
    accountName: body.accountName ?? body.accountId ?? '主账号',
    accountsFile: undefined,
    accountsSecret: currentAccounts,
    credentialKey: config.credentialKey,
    writeAccounts: payload => env.KV.put(config.accountsKey, payload),
  })
  return {
    accountId: body.accountId ?? 'main',
    ...(mode === 'send-code' ? { deviceId } : {}),
  }
}

function createCloudflareTaygedoApi(): TaygedoApi {
  return new TaygedoApi({ userCenterFetch: cloudflareUserCenterFetch })
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

interface LoginRequestBody {
  mode?: string
  phone: string
  password?: string
  captcha?: string
  deviceId?: string
  newDevice?: boolean
  accountId?: string
  accountName?: string
}

async function readLoginBody(request: Request): Promise<LoginRequestBody> {
  if (request.method !== 'POST') {
    throw new HttpError(405, 'Cloudflare 登录接口必须使用 POST')
  }
  const body = await request.json() as unknown
  if (!isRecord(body)) {
    throw new HttpError(400, '登录请求必须是 JSON 对象')
  }
  return validateLoginBody(body)
}

async function tryReadCloudflareAccounts(env: CloudflareEnv, key: string, fallback?: string): Promise<string | undefined> {
  return await env.KV.get(key) ?? fallback
}

function envToStrings(env: CloudflareEnv): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = {
    TAYGEDO_ACCOUNT_STORE: 'cloudflare-kv',
    TAYGEDO_STATE_STORE: 'cloudflare-kv',
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      values[key] = value
    }
  }
  return values
}

export function constantTimeTokenMatches(expected: string, actual: string | null): boolean {
  const expectedBytes = new TextEncoder().encode(expected)
  const actualBytes = new TextEncoder().encode(actual ?? '')
  const length = Math.max(expectedBytes.length, actualBytes.length)
  let diff = expectedBytes.length ^ actualBytes.length

  for (let index = 0; index < length; index++) {
    diff |= (expectedBytes[index] ?? 0) ^ (actualBytes[index] ?? 0)
  }

  return diff === 0
}

function validateLoginBody(body: Record<string, unknown>): LoginRequestBody {
  const mode = optionalStringField(body, 'mode') ?? 'password'
  if (mode !== 'password' && mode !== 'send-code' && mode !== 'login') {
    throw new HttpError(400, '登录模式无效')
  }

  const phone = requiredStringField(body, 'phone', 32)
  if (!/^1\d{10}$/.test(phone)) {
    throw new HttpError(400, '登录手机号格式无效')
  }

  const result: LoginRequestBody = { mode, phone }
  const password = optionalStringField(body, 'password', 256, { trim: false })
  if (password !== undefined) {
    result.password = password
  }
  const captcha = optionalStringField(body, 'captcha', 16)
  if (captcha !== undefined) {
    if (!/^\d{4,8}$/.test(captcha)) {
      throw new HttpError(400, '短信验证码格式无效')
    }
    result.captcha = captcha
  }
  const deviceId = optionalStringField(body, 'deviceId', 128)
  if (deviceId !== undefined) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(deviceId)) {
      throw new HttpError(400, '设备 ID 格式无效')
    }
    result.deviceId = deviceId
  }
  const accountId = optionalStringField(body, 'accountId', 64)
  if (accountId !== undefined) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(accountId)) {
      throw new HttpError(400, '账号 ID 格式无效')
    }
    result.accountId = accountId
  }
  const accountName = optionalStringField(body, 'accountName', 64)
  if (accountName !== undefined) {
    result.accountName = accountName
  }
  if (body.newDevice !== undefined) {
    if (typeof body.newDevice !== 'boolean') {
      throw new HttpError(400, 'newDevice 必须是布尔值')
    }
    result.newDevice = body.newDevice
  }

  return result
}

function requiredStringField(body: Record<string, unknown>, field: string, maxLength: number): string {
  const value = optionalStringField(body, field, maxLength)
  if (value === undefined) {
    throw new HttpError(400, `缺少${field}`)
  }
  return value
}

function optionalStringField(
  body: Record<string, unknown>,
  field: string,
  maxLength = 128,
  options: { trim?: boolean } = {},
): string | undefined {
  const value = body[field]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new HttpError(400, `${field} 必须是字符串`)
  }
  const trimmed = options.trim === false ? value : value.trim()
  if (trimmed === '') {
    return undefined
  }
  if (trimmed.length > maxLength) {
    throw new HttpError(400, `${field} 过长`)
  }
  return trimmed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
