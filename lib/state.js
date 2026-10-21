import { join } from 'node:path'
import { getDataDir, atomicWriteJson, readJsonSafe } from './store.js'

export function getLocalDayKey(date = new Date()) {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Hong_Kong'
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(date)
  } catch {
    return date.toISOString().slice(0, 10)
  }
}

function getLocalTimeMinutes(date = new Date()) {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Hong_Kong'
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(date)
    const h = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10)
    const m = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10)
    return h * 60 + m
  } catch {
    return date.getHours() * 60 + date.getMinutes()
  }
}

export function inWindows(date, windows) {
  if (!Array.isArray(windows) || windows.length === 0) return true
  const nowMin = getLocalTimeMinutes(date)

  for (const win of windows) {
    const match = win.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/)
    if (!match) continue
    const startMin = parseInt(match[1], 10) * 60 + parseInt(match[2], 10)
    const endMin = parseInt(match[3], 10) * 60 + parseInt(match[4], 10)

    if (startMin <= endMin) {
      if (nowMin >= startMin && nowMin <= endMin) return true
    } else {
      // 跨午夜窗口，例如 22:00-06:00
      if (nowMin >= startMin || nowMin <= endMin) return true
    }
  }
  return false
}

export function createStateManager(opts = {}) {
  const statePath = join(getDataDir(), 'state.json')
  const saved = readJsonSafe(statePath, {})

  const rt = {
    lockedForAbsence: Boolean(saved.lockedForAbsence),
    lastDeliverAt: saved.lastDeliverAt ? Number(saved.lastDeliverAt) : 0,
    lastFailureAt: saved.lastFailureAt ? Number(saved.lastFailureAt) : 0,
    failStreak: Number(saved.failStreak) || 0,
    previousIdleSeconds: 0,
    lastSkipReason: null,
    lastError: null,
    dailyCounts: saved.dailyCounts && typeof saved.dailyCounts === 'object' ? saved.dailyCounts : {}
  }

  const FAILURE_BACKOFF_BASE_MS = 3 * 60_000
  const FAILURE_BACKOFF_MAX_MS = 30 * 60_000

  function getFailureBackoffMs() {
    if (!rt.failStreak) return 0
    const exp = Math.min(rt.failStreak - 1, 4)
    return Math.min(FAILURE_BACKOFF_BASE_MS * 2 ** exp, FAILURE_BACKOFF_MAX_MS)
  }

  function getDailyCount(date = new Date()) {
    const key = getLocalDayKey(date)
    return rt.dailyCounts[key] || 0
  }

  function incrementDailyCount(date = new Date()) {
    const key = getLocalDayKey(date)
    rt.dailyCounts[key] = (rt.dailyCounts[key] || 0) + 1
    persist()
  }

  function persist() {
    try {
      atomicWriteJson(statePath, {
        lockedForAbsence: rt.lockedForAbsence,
        lastDeliverAt: rt.lastDeliverAt,
        lastFailureAt: rt.lastFailureAt,
        failStreak: rt.failStreak,
        dailyCounts: rt.dailyCounts,
        savedAt: new Date().toISOString()
      })
    } catch (e) {
      // 状态落不了盘要让界面看得出来：否则冷却/失败次数/每日计数重启即归零，
      // 会出现「刚推过又推一遍」，而日志里只剩一行看不懂的东西。
      rt.lastError = '状态没写进磁盘：' + String(e?.message || e)
    }
  }

  function evaluate(now, snap, cfg) {
    const skip = (reason) => {
      rt.lastSkipReason = reason
      return { ok: false, reason }
    }

    if (!cfg.enabled) return skip('disabled')
    if (cfg.paused) return skip('paused')
    if (!inWindows(now, cfg.windows)) return skip('outsideWindow')

    // 没选投递目标就先别跑：采集和唤醒会话都要付代价，而结果一定发不出去
    const ids = Array.isArray(cfg.sessionIds) ? cfg.sessionIds.filter(Boolean) : []
    if (ids.length === 0) return skip('noTarget')

    const idleSec = snap?.idleSeconds || 0

    // 闲置探测挂掉时：闲时运行暂时停用；持续运行不做闲置门槛（按真实时钟与冷却判定）
    if (snap?.probeDown) {
      if (cfg.mode === 'idle-only') return skip('probeDown')
      rt.previousIdleSeconds = idleSec
    } else {
      // 时钟跳变或回座检测（idleSeconds 由大变小）
      if (rt.previousIdleSeconds > 60 && idleSec < 60) {
        rt.lockedForAbsence = false
      }
      rt.previousIdleSeconds = idleSec

      // 闲置门槛只对「闲时单次」生效；「持续运行」靠冷却/每日上限/时段控制频率
      if (cfg.mode !== 'continuous' && idleSec < cfg.idleThresholdMin * 60) {
        rt.lockedForAbsence = false // 回座 -> 解除离席锁
        return skip('idleBelow')
      }
    }

    if (cfg.mode === 'idle-only' && rt.lockedForAbsence) {
      return skip('alreadyFiredThisAbsence')
    }

    // 失败退避：没有 lastDeliverAt 时（例如投递一直失败），避免每个 pollSec 都重试一次。
    // 时间戳晚于当前时间（时钟回拨/手动改表）时差值会是负数，直接当成过期，别把自己永久锁死。
    if (rt.lastFailureAt && now.getTime() - rt.lastFailureAt < 0) {
      rt.lastFailureAt = 0
    }
    if (rt.lastFailureAt && now.getTime() - rt.lastFailureAt < getFailureBackoffMs()) {
      return skip('cooldown')
    }

    if (rt.lastDeliverAt && now.getTime() - rt.lastDeliverAt < 0) {
      rt.lastDeliverAt = 0
    }
    if (rt.lastDeliverAt && now.getTime() - rt.lastDeliverAt < cfg.minGapMin * 60_000) {
      return skip('cooldown')
    }

    if (getDailyCount(now) >= cfg.maxPerDay) {
      return skip('dailyCap')
    }

    rt.lastSkipReason = null
    return { ok: true }
  }

  function recordDeliverySuccess(now = new Date(), mode = 'continuous') {
    rt.lastDeliverAt = now.getTime()
    rt.lastFailureAt = 0
    rt.failStreak = 0
    if (mode === 'idle-only') {
      rt.lockedForAbsence = true
    }
    incrementDailyCount(now)
    persist()
  }

  function recordFailure(now = new Date(), err = null) {
    rt.lastFailureAt = now.getTime()
    rt.failStreak = Math.min(rt.failStreak + 1, 10)
    if (err) rt.lastError = String(err.message || err)
    persist()
  }

  function setLastError(err) {
    rt.lastError = err ? String(err.message || err) : null
  }

  function getRuntimeSnapshot() {
    return {
      lockedForAbsence: rt.lockedForAbsence,
      lastDeliverAt: rt.lastDeliverAt,
      lastFailureAt: rt.lastFailureAt,
      failStreak: rt.failStreak,
      lastSkipReason: rt.lastSkipReason,
      lastError: rt.lastError,
      todayCount: getDailyCount(new Date())
    }
  }

  return {
    evaluate,
    recordDeliverySuccess,
    recordFailure,
    setLastError,
    getDailyCount,
    getRuntimeSnapshot,
    persist
  }
}
