import { shanghaiDateTime, type DailySchedule } from '../utils/time.js'

export type { DailySchedule }

export interface LoopRunnerOptions {
  loopSeconds?: number
  dailyAt?: DailySchedule
  runOnce: () => Promise<void>
  schedule?: (callback: () => void, delayMs: number) => unknown
  log?: (message: string) => void
}

const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export function nextDailyRunAt(dailyAt: DailySchedule, now = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)

  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? '01'
  const todayRunAtUtcMs = Date.UTC(
    Number(value('year')),
    Number(value('month')) - 1,
    Number(value('day')),
    dailyAt.hour,
    dailyAt.minute,
  ) - SHANGHAI_UTC_OFFSET_MS
  const nextRunAtUtcMs = todayRunAtUtcMs > now.getTime() ? todayRunAtUtcMs : todayRunAtUtcMs + DAY_MS
  return new Date(nextRunAtUtcMs)
}

export function msUntilDailySchedule(dailyAt: DailySchedule, now = new Date()): number {
  return nextDailyRunAt(dailyAt, now).getTime() - now.getTime()
}

export function formatDailySchedule(dailyAt: DailySchedule): string {
  const hour = String(dailyAt.hour).padStart(2, '0')
  const minute = String(dailyAt.minute).padStart(2, '0')
  return `${hour}:${minute}`
}

export async function runWithOptionalLoop(options: LoopRunnerOptions): Promise<void> {
  const log = options.log ?? ((message: string) => console.log(message))
  const schedule = options.schedule ?? setTimeout
  const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error))

  if (options.dailyAt) {
    const dailyAt = options.dailyAt
    const startupNextRunAt = nextDailyRunAt(dailyAt)
    log(`定时模式：每日 ${formatDailySchedule(dailyAt)}（Asia/Shanghai）自动执行`)

    // 首跑失败不能让常驻模式退出：否则一次启动抖动（账号文件读不到、状态写入失败等）会让每日定时永久失效。
    // 一次性任务和循环模式仍保持“首跑失败即抛错”的语义。
    try {
      await options.runOnce()
    } catch (error) {
      log(`首次执行失败：${describeError(error)}`)
    }

    let firstArm = true

    function arm(): void {
      const now = new Date()
      if (firstArm && startupNextRunAt.getTime() <= now.getTime()) {
        log(`已错过 ${shanghaiDateTime(startupNextRunAt)} 的定时执行（首次执行耗时过长），本次跳过`)
      }
      firstArm = false
      const nextRunAt = nextDailyRunAt(dailyAt, now)
      // 下一次定时器只在本次执行结束后才装上，因此每日任务不会并发重入。
      log(`下次执行时间：${shanghaiDateTime(nextRunAt)}`)
      schedule(() => {
        void runScheduled()
      }, nextRunAt.getTime() - now.getTime())
    }

    async function runScheduled(): Promise<void> {
      try {
        await options.runOnce()
      } catch (error) {
        log(`执行失败：${describeError(error)}`)
      } finally {
        arm()
      }
    }

    arm()
    return
  }

  await options.runOnce()
  if (!options.loopSeconds) {
    return
  }

  const nextRunAt = new Date(Date.now() + options.loopSeconds * 1000)
  log(`循环模式：每 ${options.loopSeconds} 秒执行一次，下次执行时间：${shanghaiDateTime(nextRunAt)}`)
  schedule(() => {
    runWithOptionalLoop(options).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
    })
  }, options.loopSeconds * 1000)
}
