import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { loadConfig } from './config.js'
import { sendDesktopNotification } from './notify.js'

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

// 缓存会话标题，避免同一会话每次弹窗都进行文件系统 I/O
const titleCache = new Map() // sessionId -> { title: string, expireAt: number }

function isRawId(str) {
  return /^session-[0-9a-fA-F-]+$/.test(str) ||
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(str)
}

/**
 * 解析会话的真实人类可读标题
 * 优先从 DSH 宿主的 session_projcache 获取，杜绝将底层内部 UUID 暴露给用户
 */
function resolveSessionTitle(session) {
  if (!session) return '当前会话'

  // 1. 如果运行时对象自带了可读标题且非裸 UUID
  const directTitle = session.title || session.name
  if (typeof directTitle === 'string' && directTitle.trim() && !isRawId(directTitle.trim())) {
    return directTitle.trim()
  }

  const rawId = session.id
  if (!rawId) return '当前会话'

  // 2. 查内存缓存（30 秒有效）
  const cached = titleCache.get(rawId)
  if (cached && Date.now() < cached.expireAt) {
    return cached.title
  }

  // 3. 从 DSH 宿主的 session_projcache 读取真实标题
  const cleanId = String(rawId).replace(/^session-/, '')
  const sessionsDir = path.join(dshHome(), 'storages', 'session_projcache', 'sessions')
  const candidates = [
    path.join(sessionsDir, `session-${cleanId}.json`),
    path.join(sessionsDir, `${cleanId}.json`)
  ]

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        const data = JSON.parse(fs.readFileSync(c, 'utf8'))
        const val = data?.record?.rows?.title?.val || data?.title
        if (typeof val === 'string' && val.trim()) {
          const res = val.trim()
          titleCache.set(rawId, { title: res, expireAt: Date.now() + 30000 })
          return res
        }
      }
    } catch {}
  }

  // 4. 若为新会话且尚未生成标题，优雅兜底，杜绝暴露生硬 UUID
  const fallback = '当前会话'
  titleCache.set(rawId, { title: fallback, expireAt: Date.now() + 5000 })
  return fallback
}

/**
 * 监听 DSH 全局会话事件，实现原生桌面弹窗通知。
 * 覆盖场景：
 * 1. AI 完成本轮回复 (turn/end，正常结束)
 * 2. 需要用户操作 (tool/call ask_user_question / exit_plan_mode / 权限审批)
 * 3. 运行出错 (turn/end 且 reason 为 error)
 */
export function createSessionEventListener(ctx, logger) {
  // 防抖记录：同一会话在短时间内避免重复弹窗
  const recentNotifies = new Map() // key: sessionId -> timestamp

  function shouldThrottle(key, intervalMs = 2500) {
    const now = Date.now()
    const last = recentNotifies.get(key) || 0
    if (now - last < intervalMs) return true
    recentNotifies.set(key, now)
    return false
  }

  // 获取会话可读标题
  function getSessionTitle(session) {
    return resolveSessionTitle(session)
  }

  // 核心事件处理器
  function onSessionEvent(session, event) {
    try {
      const cfg = loadConfig()
      const dCfg = cfg.desktopNotify || {}
      if (!dCfg.enabled) return

      const sessionId = session?.id || 'unknown'
      const sessionTitle = getSessionTitle(session)

      // 1. 需要用户操作 / 提问 / 计划退出
      if (dCfg.onActionRequired && event.type === 'tool/call') {
        const name = event.data?.name || ''
        if (name === 'ask_user_question' || name === 'exit_plan_mode') {
          if (shouldThrottle(`action:${sessionId}`)) return
          
          let detail = 'AI 正在等待您的回复或确认'
          if (name === 'ask_user_question') {
            try {
              const args = typeof event.data.arguments === 'string'
                ? JSON.parse(event.data.arguments)
                : (event.data.arguments || {})
              const q = args?.questions?.[0]?.question || args?.question
              if (q) detail = `提问：${q}`
            } catch {}
          } else if (name === 'exit_plan_mode') {
            detail = 'AI 提出了方案，请前往查看并确认'
          }

          sendDesktopNotification({
            title: `🔔 需要操作 · ${sessionTitle}`,
            body: detail,
            sound: Boolean(dCfg.sound)
          }).catch(() => {})
          return
        }
      }

      // 2. 回合结束：回复完成 或 发生错误
      if (event.type === 'turn/end') {
        const reason = event.data?.reason
        const isError = reason?.kind === 'error' || Boolean(event.data?.error)

        if (isError) {
          if (!dCfg.onError) return
          if (shouldThrottle(`error:${sessionId}`)) return
          const errMsg = reason?.error?.message || event.data?.error?.message || '模型运行出现异常'
          sendDesktopNotification({
            title: `⚠️ 运行出错 · ${sessionTitle}`,
            body: errMsg,
            sound: Boolean(dCfg.sound)
          }).catch(() => {})
          return
        }

        // 正常完成（filtered cancelled / aborted if desired, or notify completion）
        if (dCfg.onComplete) {
          if (reason?.kind === 'cancelled' || reason?.kind === 'aborted') return
          if (shouldThrottle(`complete:${sessionId}`)) return

          sendDesktopNotification({
            title: `✅ 回复完成 · ${sessionTitle}`,
            body: 'AI 思考与回答已生成完毕',
            sound: Boolean(dCfg.sound)
          }).catch(() => {})
        }
      }
    } catch (e) {
      logger?.debug?.('Session event notify error: ' + (e?.message || e))
    }
  }

  // 注册全局会话事件监听
  let off = null
  try {
    off = ctx.on('session/event', (session, event) => {
      onSessionEvent(session, event)
    }, { global: true })
  } catch (e) {
    logger?.warn?.('Failed to register session/event listener for desktop notify: ' + (e?.message || e))
  }

  return {
    stop: () => {
      if (typeof off === 'function') {
        try { off() } catch {}
      }
    }
  }
}
