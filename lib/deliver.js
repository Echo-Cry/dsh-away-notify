// 投递：把资讯写进配置里选中的会话，并可顺带同步一份到手机/群。
//
// 会话投递不用 sessionController.prompt，也不唤醒任何模型：
// 直接往会话日志里补一整轮「turn/start → step/start → assistant/message → step/end → turn/end」。
// 这样界面上显示为「助手发来的一条消息」，不会出现「用户自己发的」气泡，也不产生任何 Token。
import { listChats } from './imchat.js'

const MESSAGE_SOURCE = { kind: 'model', provider: 'away-notify', model: 'away-notify' }
let seq = 0

function withTimeout(promise, ms, label) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function stripPrefix(id) {
  return String(id || '').replace(/^session-/, '')
}

function eventsOf(session) {
  try {
    const events = session?.snapshotEvents?.()
    return Array.isArray(events) ? events : []
  } catch {
    return []
  }
}

// 会话里是否有没闭合的轮次（用户正在聊/工具正在跑）
function openTurn(events) {
  let open = null
  for (const event of events) {
    if (event?.type === 'turn/start') open = event.data?.turn ?? open
    else if (event?.type === 'turn/end' && open === event.data?.turn) open = null
  }
  return open
}

function nextTurn(events) {
  let max = 0
  for (const event of events) {
    if (event?.type === 'turn/start' && Number.isFinite(event.data?.turn)) {
      max = Math.max(max, event.data.turn)
    }
  }
  return max + 1
}

// 把一个「助手通知」作为一整轮写进会话日志（不触发模型）
function appendNoticeTurn(session, text) {
  const events = eventsOf(session)
  const busy = openTurn(events)
  if (busy !== null) {
    return { ok: false, code: 'session-busy', error: '会话正在跑别的轮次，这条留到下次再推' }
  }
  if (typeof session?.append !== 'function') {
    return { ok: false, code: 'no-append', error: '这个会话不支持直接写入消息' }
  }
  const turn = nextTurn(events)
  const message = {
    id: `away-notify-${Date.now().toString(36)}-${++seq}`,
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: MESSAGE_SOURCE
  }
  // 5 次写入没有事务：中间任何一次抛错，turn/start 已经落盘、turn/end 不会再补，
  // 之后 openTurn() 会一直认为这轮没结束，这个会话就被永久判成「正忙」。
  // 所以失败时先补一条 turn/end 收尾，再抛出去。
  try {
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', { turn, step: 1, message, stream: [] }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  } catch (e) {
    try { session.append('turn/end', { turn, reason: { kind: 'failed' } }) } catch {}
    throw e
  }
  return { ok: true, messageId: message.id, turn }
}

async function acquireSession(ctx, sessionId) {
  // 1) 已经活着：直接写，最省事
  const agents = ctx.get('agents')
  const live = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
  if (live) {
    const session = live.session || (typeof live.snapshotEvents === 'function' ? live : null)
    if (session) return { session, via: 'live', resumed: false, dispose: null }
  }

  // 2) sessionController.resolveAgent —— GUI 里「点开会话」走的就是这条路。
  //    它同样把会话挂进宿主的 live registry，但归属在宿主这一侧：插件停用/重载都不会把会话摘掉，
  //    侧栏那一行会由 api-session/added 重新长回来，之后也一直留着。
  //    这正是修掉「投递完会话从工作区消失」的关键（agents.resume 的挂载是插件私有的，会被收回）。
  const sc = ctx.get('sessionController')
  if (typeof sc?.resolveAgent === 'function') {
    try {
      const r = await withTimeout(Promise.resolve(sc.resolveAgent(sessionId)), 45000, 'resolveAgent session')
      const agent = r?.agent ?? r
      const session = agent?.session || (typeof agent?.snapshotEvents === 'function' ? agent : null)
      if (session) return { session, via: 'resolve', resumed: false, dispose: null }
    } catch {
      /* 落到下面用 agents.resume 兜底 */
    }
  }

  // 3) 兜底：agents.resume（这种挂载跟着插件上下文走，插件一卸载会话就被摘掉，只当最后手段）
  if (typeof agents?.resume !== 'function') {
    throw new Error(`会话 ${sessionId} 没在运行，且宿主不支持唤醒`)
  }
  const handle = await withTimeout(
    Promise.resolve(agents.resume({ resumeSessionId: sessionId })),
    45000,
    'resume session'
  )
  const agent = handle?.agent ?? handle
  const session = agent?.session || (typeof agent?.snapshotEvents === 'function' ? agent : null)
  if (!session) throw new Error('唤醒会话后拿不到会话对象')
  return {
    session,
    via: 'resume',
    resumed: true,
    dispose: async () => {
      try {
        await handle?.dispose?.()
      } catch {}
    }
  }
}

async function deliverToSession(ctx, sessionId, text) {
  let acquired = null
  try {
    acquired = await acquireSession(ctx, sessionId)
  } catch (e) {
    return { sessionId, ok: false, how: 'append', resumed: false, error: String(e?.message || e) }
  }
  try {
    const res = appendNoticeTurn(acquired.session, text)
    if (!res.ok) {
      return { sessionId, ok: false, how: 'append', resumed: acquired.resumed, code: res.code, error: res.error }
    }
    let landed = false
    try {
      landed = eventsOf(acquired.session).some(
        (event) => event?.type === 'assistant/message' && event.data?.message?.id === res.messageId
      )
    } catch {}
    try {
      await ctx.get('sessions')?.flush?.(acquired.session)
    } catch {}
    // 投递完再看一眼：目标会话是否仍挂在宿主的 live registry 里（侧栏行就是靠它显示）
    let stillLive = false
    try {
      stillLive = Boolean(ctx.get('agents')?.get?.(sessionId))
    } catch {}
    // landed=false 说明消息没真正出现在会话事件流里，这时不能报成功，
    // 否则界面/账单/日志都说「已推送」，用户打开会话却一条也没有。
    return {
      sessionId,
      ok: landed,
      code: landed ? null : 'not-landed',
      how: 'append',
      via: acquired.via,
      resumed: acquired.resumed,
      landed,
      stillLive,
      turn: res.turn,
      error: landed ? null : '消息没有落进会话日志'
    }
  } catch (e) {
    return { sessionId, ok: false, how: 'append', via: acquired.via, resumed: acquired.resumed, error: String(e?.message || e) }
  }
  // 注意：**这里不 dispose**。
  // acquireSession 唤醒会话用两条路：sessionController.resolveAgent（归属宿主，插件卸载也不会被摘掉）
  // 和 agents.resume（归属插件，插件一卸载就收回去）。dispose() 会把它重新摘出 live registry，
  // 宿主随之发 api-session/removed，GUI 侧栏就把这一行移除了 —— 用户看到的「投递完会话不见了」正是这个 detach。
  // 磁盘日志与 workspace.json 登记其实都完好，所以只是「行消失了」，数据没丢。
  // 保持挂载后：侧栏行留着、后续投递走 live 快路径、也不必每次重放整段日志。
}

// 顺便同步一份到手机/群。
// QQ、飞书这类桥接通道是「你先发一条、桥接才回一条」的请求-应答模型，
// 我们写进 DSH 会话的消息不是从手机发起的，桥接不会把它回传过去，
// 所以这里用 dsh-im 自己的出站接口再发一份。
//
// mode = 'follow'：每条推送发到「这个会话对应的那个 IM 聊天」（群会话 → 群，私聊 → 私聊）
// mode = 'fixed' ：所有推送都发到指定的那一个对话
async function syncToIm(ctx, cfg, text, delivered, signal) {
  const im = cfg?.imSync
  if (!im?.enabled) return null
  const svc = ctx.get('dshIm')
  if (!svc || typeof svc.send !== 'function') {
    return { ok: false, count: 0, sent: [], error: '宿主里没有可用的 dsh-im 投递服务，手机上收不到' }
  }

  // 聊天清单只读一次：syncToIm 和群发退私聊的兜底都要用，
  // 而 listChats() 会把所有会话标题文件同步读一遍，读两次会明显拖慢轮询。
  let chatsCache = null
  const chats = () => (chatsCache ??= listChats())

  const targets = []
  if (im.mode === 'fixed') {
    const target = im.targetId ? im.targetId : (im.kind && im.route ? { kind: im.kind, route: im.route } : null)
    if (!target) return { ok: false, count: 0, sent: [], error: '没有选择要同步到的对话' }
    targets.push({ botId: im.botId, target, label: im.label || '选定的对话', channel: im.channel || '' })
  } else {
    const seen = new Set()
    for (const record of delivered) {
      if (!record?.ok) continue
      const chat = chats().find((c) => stripPrefix(c.sessionId) === stripPrefix(record.sessionId))
      if (!chat) continue
      const key = `${chat.botId}|${chat.kind}|${JSON.stringify(chat.route)}`
      if (seen.has(key)) continue
      seen.add(key)
      targets.push({ botId: chat.botId, target: { kind: chat.kind, route: chat.route }, label: chat.label, channel: chat.channel })
    }
    if (targets.length === 0) {
      return {
        ok: false,
        count: 0,
        sent: [],
        error: '这些会话没有对应的 IM 聊天，手机收不到（可以把「同步到手机」改成一个固定对话）'
      }
    }
  }

  // 群聊经常发不出去：QQ 群只允许「被动回复」（必须引用一条刚收到的群消息），
  // 主动往群里推会被平台拒掉（API 报「主动消息失败，无权限」）。
  // 遇到这种失败就退回这个机器人对应的私聊，保证手机上还是能收到。
  const privateChatFor = (botId, channel) => {
    try {
      const mine = chats().filter((c) => c.botId === botId && (!channel || c.channel === channel)
        // 各通道「私聊」的 kind 不统一：qq 是 user、telegram 是 chat、discord 是 channel，
        // 所以这里排掉「肯定是多人会话」的 kind，而不是只认 'user'。
        && c.kind !== 'group' && c.kind !== 'room' && c.kind !== 'thread')
      mine.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
      return mine[0] || null
    } catch {
      return null
    }
  }

  const sendOnce = async (botId, target) => {
    const res = await withTimeout(
      Promise.resolve(svc.send(botId, target, text, { format: 'plain', signal })),
      30000,
      'im send'
    )
    return res?.sent === true || res?.ok === true || Boolean(res?.messageId) || Boolean(res?.id)
  }

  const sent = []
  for (const item of targets) {
    try {
      const ok = await sendOnce(item.botId, item.target)
      if (ok) sent.push({ label: item.label, ok: true, error: null })
      else sent.push({ label: item.label, ok: false, error: 'dsh-im 没有确认发送成功' })
    } catch (e) {
      const reason = `发送失败：${e?.message || e}`
      if (item.target?.kind === 'group') {
        const priv = privateChatFor(item.botId, item.channel)
        if (priv) {
          try {
            const ok = await sendOnce(priv.botId, { kind: priv.kind, route: priv.route })
            if (ok) {
              sent.push({
                label: item.label,
                ok: true,
                fallback: true,
                note: '群不支持主动推送，已改发私聊',
                routedTo: priv.label,
                error: null
              })
              continue
            }
          } catch {
            /* 私聊也失败，走下面的失败分支 */
          }
        }
      }
      sent.push({ label: item.label, ok: false, error: reason })
    }
  }
  const okCount = sent.filter((s) => s.ok).length
  const failed = sent.filter((s) => !s.ok)
  return {
    ok: okCount === sent.length,
    count: sent.length,
    sent,
    error: failed.length === 0
      ? null
      : `${failed.length} 个对话没发出去：` + failed.slice(0, 2).map((s) => `${s.label}（${s.error}）`).join('；')
  }
}

/**
 * 投递到配置里选中的所有会话，再按配置同步一份到手机/群。
 * 返回 { ok, delivered: [{sessionId, ok, how, resumed, landed, error}], failCount, okCount, targets, imSync, partial }
 * ok 表示「至少一个会话收到了」；partial 表示「还有会话没收到」，调度层据此把失败原因摆到界面上。
 */
export async function deliver(ctx, cfg, text, { signal } = {}) {
  const cleanText = (text || '').trim()
  if (!cleanText) {
    return { ok: false, error: 'emptyCompose', delivered: [], failCount: 0, okCount: 0, targets: [], imSync: null, partial: false }
  }

  const ids = (Array.isArray(cfg.sessionIds) ? cfg.sessionIds : []).map(s => String(s || '').trim()).filter(Boolean)
  if (ids.length === 0) {
    return {
      ok: false,
      code: 'no-target',
      error: '未选择投递会话：请先在设置里选至少一个会话',
      delivered: [],
      failCount: 0,
      okCount: 0,
      targets: [],
      imSync: null,
      partial: false
    }
  }

  // 每个会话最坏要等两次 45s（唤醒 + 兜底），目标一多就会把整轮调度拖住；
  // 这里给整批一个总预算，超时后剩下的直接记失败，不再逐个干等。
  const deadline = Date.now() + 150000
  const delivered = []
  for (const sessionId of ids) {
    const outOfBudget = Date.now() > deadline
    const cancelled = signal?.aborted === true
    if (outOfBudget || cancelled) {
      delivered.push({
        sessionId,
        ok: false,
        how: 'append',
        resumed: false,
        error: cancelled ? '这轮已被取消' : '前面的会话等太久，这条先跳过'
      })
      continue
    }
    delivered.push(await deliverToSession(ctx, sessionId, cleanText))
  }
  const okCount = delivered.filter(d => d.ok).length
  const failCount = delivered.length - okCount

  let imSync = null
  try {
    imSync = await syncToIm(ctx, cfg, cleanText, delivered, signal)
  } catch (e) {
    imSync = { ok: false, count: 0, sent: [], error: `手机同步出错：${e?.message || e}` }
  }

  const failed = delivered.filter(d => !d.ok)
  return {
    ok: okCount > 0,
    partial: okCount > 0 && failCount > 0,
    delivered,
    okCount,
    failCount,
    targets: ids,
    imSync,
    error: failed.length === 0
      ? null
      : `${failCount} 个会话没投成功：` + failed.slice(0, 2).map(d => `${String(d.sessionId || '').slice(-8)}（${d.error}）`).join('；')
  }
}
