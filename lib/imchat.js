// IM 对话（dsh-im 桥接过的聊天）发现：把「会话 → IM 聊天」的映射读出来。
//
// 为什么不用 dsh-im 的接口：它只对外暴露 send / listTargets / listBots 等少数方法
// （listTargets 只列用户在 dsh-im 设置里手工登记过的投递目标，通常为空），
// 所以这里直接读它自己的状态文件：integrations/dsh-<channel>/{bots,accounts}/<id>/state.json
// 里的 sessions 字段就是「聊天键 → DSH 会话 id」。
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { loadSessionTitles } from './sessions.js'

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function stripPrefix(id) {
  return String(id || '').replace(/^session-/, '')
}

// 各通道的「聊天键 → 投递路由」规则，与 dsh-im 内部的 normalizeRoute 保持一致。
function routeFromKey(channel, key) {
  const idx = key.indexOf(':')
  if (idx <= 0) return null
  const prefix = key.slice(0, idx)
  const rest = key.slice(idx + 1)
  if (!rest) return null
  const user = (route) => ({ kind: 'user', route })
  const group = (route) => ({ kind: 'group', route })

  switch (channel) {
    case 'qq':
      if (prefix === 'c2c') return user({ userOpenId: rest })
      if (prefix === 'group') return group({ groupOpenId: rest })
      return null
    case 'weixin':
      return prefix === 'p2p' ? user({ toUserId: rest }) : null
    case 'feishu':
      if (prefix === 'p2p' && rest.startsWith('ou_')) return user({ openId: rest })
      if (prefix === 'group') return group({ chatId: rest })
      return null
    case 'dingtalk':
      if (prefix === 'p2p') return user({ userId: rest })
      if (prefix === 'group') return group({ openConversationId: rest })
      return null
    case 'wecom':
    case 'wecom-app':
      if (prefix === 'direct' || prefix === 'p2p') return user({ chatId: rest })
      if (prefix === 'group') return group({ chatId: rest })
      return null
    case 'telegram': {
      // dsh-im 的 telegram 只接受 chat / topic 两种 kind：
      // group:-100123:5 这种带话题号的键要落成 topic，直聊和普通群都按 chat 发。
      const m = /^(direct|group):(-?\d+)(?::(\d+))?$/.exec(key)
      if (!m) return null
      const chatId = m[2]
      if (!m[3]) return { kind: 'chat', route: { chatId } }
      return { kind: 'topic', route: { chatId, messageThreadId: Number(m[3]) } }
    }
    case 'discord':
      // discord 只认 channel 这一种 kind（私聊频道也是 channel）
      return { kind: 'channel', route: { channelId: rest } }
    case 'whatsapp': {
      const m = /^(direct|group):(.+@(?:s\.whatsapp\.net|lid|g\.us))$/.exec(key)
      if (!m) return null
      return prefix === 'group' ? group({ jid: m[2] }) : user({ jid: m[2] })
    }
    case 'matrix':
      if (prefix === 'dm') return { kind: 'dm', route: { userId: rest } }
      if (prefix === 'room') return { kind: 'room', route: { roomId: rest } }
      return null
    case 'slack':
      return prefix === 'direct' ? { kind: 'conversation', route: { channelId: rest } } : null
    default:
      return null
  }
}

const CHANNEL_LABEL = {
  qq: 'QQ',
  weixin: '微信',
  feishu: '飞书',
  dingtalk: '钉钉',
  wecom: '企业微信',
  'wecom-app': '企业微信',
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  whatsapp: 'WhatsApp',
  matrix: 'Matrix'
}

function shortId(route) {
  const first = Object.values(route || {})[0]
  return String(first || '').slice(0, 8)
}

/**
 * 列出 dsh-onebot-qq 桥接过的所有聊天。
 * 读取 ~/.dsh/media/onebot/chat-sessions.json
 */
export function listOneBotChats(options = {}) {
  const titles = options.titles || loadSessionTitles()
  const rows = []
  const mappingFile = join(dshHome(), 'media', 'onebot', 'chat-sessions.json')
  if (!existsSync(mappingFile)) return rows

  const mapping = readJsonSafe(mappingFile)
  if (!mapping || typeof mapping !== 'object') return rows

  for (const [chatId, sessionVal] of Object.entries(mapping)) {
    // 兼容 sessionVal 为字符串或者对象 { session: '...' }
    const sessionId = typeof sessionVal === 'string' ? sessionVal : sessionVal?.session
    if (typeof sessionId !== 'string' || !sessionId) continue

    const idx = chatId.indexOf(':')
    if (idx <= 0) continue
    const type = chatId.slice(0, idx)
    const targetId = chatId.slice(idx + 1)
    if (!targetId) continue

    const isGroup = type === 'group'
    const title = titles.get(stripPrefix(sessionId)) || ''
    const label = `QQ ${isGroup ? '群聊' : '私聊'} · ${targetId}`

    rows.push({
      channel: 'onebot-qq',
      channelLabel: 'QQ',
      botId: 'onebot',
      kind: isGroup ? 'group' : 'user',
      chatId,
      route: {
        channel: 'onebot-qq',
        chatId,
        messageType: isGroup ? 'group' : 'private',
        targetId
      },
      label,
      sessionId,
      sessionTitle: title || ''
    })
  }

  // 补充扫描 retired-sessions.json，防止被退役/内存卸载的 QQ 会话丢失聊天映射
  const retiredFile = join(dshHome(), 'media', 'onebot', 'retired-sessions.json')
  if (existsSync(retiredFile)) {
    const retired = readJsonSafe(retiredFile)
    if (Array.isArray(retired)) {
      for (const sid of retired) {
        if (typeof sid !== 'string' || !sid) continue
        const norm = stripPrefix(sid)
        const m = norm.match(/^onebot-(private|group)-(\d+)$/)
        if (m) {
          const isGroup = m[1] === 'group'
          const targetId = m[2]
          const chatId = `${m[1]}:${targetId}`
          if (!rows.some(r => r.sessionId === sid || r.chatId === chatId)) {
            const title = titles.get(norm) || ''
            rows.push({
              channel: 'onebot-qq',
              channelLabel: 'QQ',
              botId: 'onebot',
              kind: isGroup ? 'group' : 'user',
              chatId,
              route: {
                channel: 'onebot-qq',
                chatId,
                messageType: isGroup ? 'group' : 'private',
                targetId
              },
              label: `QQ ${isGroup ? '群聊' : '私聊'} · ${targetId}`,
              sessionId: sid,
              sessionTitle: title || ''
            })
          }
        }
      }
    }
  }

  return rows
}

/**
 * 列出已桥接的所有聊天（聚合 dsh-im 与 dsh-onebot-qq）。
 * 返回 [{ channel, channelLabel, botId, kind, route, label, sessionId, sessionTitle }]
 */
export function listChats(options = {}) {
  const titles = options.titles || loadSessionTitles()
  const opts = { ...options, titles }
  const rows = []

  // 1. OneBot QQ 聊天
  try {
    const onebotRows = listOneBotChats(opts)
    rows.push(...onebotRows)
  } catch {}

  // 2. dsh-im 各集成通道
  const root = join(dshHome(), 'integrations')
  if (!existsSync(root)) return rows

  let channelDirs = []
  try {
    channelDirs = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
  } catch {
    return rows
  }

  for (const dir of channelDirs) {
    const m = /^dsh-(.+)$/.exec(dir)
    if (!m) continue
    const channel = m[1]
    for (const sub of ['bots', 'accounts']) {
      const base = join(root, dir, sub)
      if (!existsSync(base)) continue
      let owners = []
      try {
        owners = readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
      } catch {
        continue
      }
      for (const botId of owners) {
        const stateFile = join(base, botId, 'state.json')
        if (!existsSync(stateFile)) continue
        try {
          if (!statSync(stateFile).isFile()) continue
        } catch {
          continue
        }
        const state = readJsonSafe(stateFile)
        const sessions = state && typeof state.sessions === 'object' && state.sessions ? state.sessions : {}
        for (const [key, sessionId] of Object.entries(sessions)) {
          const mapped = routeFromKey(channel, key)
          if (!mapped) continue
          const title = titles.get(stripPrefix(sessionId)) || ''
          const groupish = mapped.kind === 'group' || mapped.kind === 'topic' || mapped.kind === 'room' || mapped.kind === 'thread'
          const label = `${CHANNEL_LABEL[channel] || channel}${groupish ? ' 群聊' : ' 私聊'} · ${shortId(mapped.route)}`
          rows.push({
            channel,
            channelLabel: CHANNEL_LABEL[channel] || channel,
            botId,
            kind: mapped.kind,
            route: mapped.route,
            label,
            sessionId,
            sessionTitle: title || ''
          })
        }
      }
    }
  }
  return rows
}

/** 找出某个 DSH 会话对应的 IM 聊天（没有就返回 null）。 */
export function chatForSession(sessionId, options = {}) {
  const target = stripPrefix(sessionId)
  const chats = options.chats || listChats(options)
  return chats.find(c => stripPrefix(c.sessionId) === target) || null
}

export { basename }
