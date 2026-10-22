import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { readAllRuns } from './billing.js'
import { detailSpec } from './config.js'
import { getLocalDayKey } from './state.js'

function extractJsonPayload(text) {
  if (!text) return null
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  const candidate = codeBlockMatch ? codeBlockMatch[1] : text
  const firstBrace = candidate.indexOf('{')
  const lastBrace = candidate.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(candidate.slice(firstBrace, lastBrace + 1))
    } catch {}
  }
  return null
}

function safeJson(value, limit = 900) {  const seen = new WeakSet()
  const text = (() => {
    try {
      return JSON.stringify(value, (key, val) => {
        if (typeof val === 'function') return `[fn ${val.name || 'anonymous'}]`
        if (val && typeof val === 'object') {
          if (seen.has(val)) return '[cycle]'
          seen.add(val)
        }
        return val
      })
    } catch (error) {
      return `[unserializable: ${error && error.message}]`
    }
  })()
  return String(text || '').slice(0, limit)
}

export function textFromChildResult(res) {
  if (typeof res === 'string') return res
  const collect = (parts) => (Array.isArray(parts) ? parts : [])
    .filter((p) => p && (p.type === 'text' || (typeof p.text === 'string' && p.type !== 'reasoning')))
    .map((p) => String(p.text || ''))
    .join('\n')
    .trim()
  // 宿主的 subagent 结果是 { output: [{type:'reasoning'|'text', text}] }
  const fromOutput = collect(res?.output)
  if (fromOutput) return fromOutput
  const fromContent = collect(res?.content)
  if (fromContent) return fromContent
  if (typeof res?.text === 'string' && res.text.trim()) return res.text
  if (typeof res?.result === 'string') return res.result
  return ''
}

export function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
}

// 子会话这次跑掉多少 token：累加会话日志里每条 assistant/message 的 usage
export function readSessionUsage(session) {
  const usage = emptyUsage()
  try {
    const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
    for (const event of Array.isArray(events) ? events : []) {
      if (event?.type !== 'assistant/message') continue
      const x = event.data?.usage
      if (!x) continue
      usage.input += Number(x.inputTokens) || 0
      usage.output += Number(x.outputTokens) || 0
      usage.cacheRead += Number(x.cacheReadTokens) || 0
      usage.cacheWrite += Number(x.cacheWriteTokens) || 0
      usage.reasoning += Number(x.reasoningTokens) || 0
    }
  } catch {}
  return usage
}

function usageTotal(usage) {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite
}

// 子会话退出后内存里读不到，就从它的会话日志（多帧 zstd 拼接）里把 usage 捞回来
export function readUsageFromDisk(childId) {
  const usage = emptyUsage()
  try {
    if (typeof zlib.zstdDecompressSync !== 'function') return usage
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const bare = String(childId).replace(/^session-/, '')
    const root = path.join(home, 'sessions')
    if (!fs.existsSync(root)) return usage
    let found = null
    for (const slug of fs.readdirSync(root)) {
      for (const name of [bare, `session-${bare}`]) {
        const file = path.join(root, slug, name, 'session.v4.jsonl.zstd')
        if (fs.existsSync(file)) {
          found = file
          break
        }
      }
      if (found) break
    }
    if (!found) return usage
    const buf = fs.readFileSync(found)
    const starts = []
    for (let i = 0; i < buf.length - 3; i++) {
      if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) {
        starts.push(i)
        i += 3
      }
    }
    if (!starts.length) return usage
    starts.push(buf.length)
    let text = ''
    for (let k = 0; k < starts.length - 1; k++) {
      try {
        text += zlib.zstdDecompressSync(buf.subarray(starts[k], starts[k + 1])).toString('utf8')
      } catch {
        /* 半帧跳过 */
      }
    }
    for (const line of text.split('\n')) {
      if (!line) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event?.type !== 'assistant/message') continue
      const x = event.data?.usage
      if (!x) continue
      usage.input += Number(x.inputTokens) || 0
      usage.output += Number(x.outputTokens) || 0
      usage.cacheRead += Number(x.cacheReadTokens) || 0
      usage.cacheWrite += Number(x.cacheWriteTokens) || 0
      usage.reasoning += Number(x.reasoningTokens) || 0
    }
  } catch {}
  return usage
}

// 子会话还在内存里时把真实用量读出来（子进程退出后就没得读了）
// 注意：activation.childId 可能是不带 session- 前缀的裸 uuid，而 sessions.get 要完整 id
function resolveUsage(ctx, childId, activation) {
  let measured = null
  try {
    const sessions = ctx.get('sessions')
    const fullId = String(childId).startsWith('session-') ? String(childId) : `session-${childId}`
    const session = sessions?.get?.(fullId) || sessions?.get?.(String(childId))
    if (session) measured = readSessionUsage(session)
  } catch {}
  const fromDisk = readUsageFromDisk(childId)
  const hinted = activation?.usage ? normalizeUsage(activation.usage) : null
  // 只有真读到非零数才算数：空对象不能挡住后面的兜底
  if (measured && usageTotal(measured) > 0) return measured
  if (usageTotal(fromDisk) > 0) return fromDisk
  if (hinted && usageTotal(hinted) > 0) return hinted
  return measured || fromDisk || emptyUsage()
}

/** 宿主 TokenUsage（inputTokens/...）或插件口径（input/...）都归一成插件口径。 */
function normalizeUsage(u) {
  const n = (v) => Number(v) || 0
  return {
    input: n(u.input ?? u.inputTokens),
    output: n(u.output ?? u.outputTokens),
    cacheRead: n(u.cacheRead ?? u.cacheReadTokens),
    cacheWrite: n(u.cacheWrite ?? u.cacheWriteTokens),
    reasoning: n(u.reasoning ?? u.reasoningTokens)
  }
}

export async function runChild(ctx, { parent, prompt, allowTools, label = 'away-notify-subagent', signal }) {
  // 宿主在创建子会话时会直接 await signal.throwIfAborted()，传 undefined 会当场炸；
  // 调用方没给就兜一个默认超时，别让「少传一个参数」变成整条链失败。
  const abortSignal = signal || AbortSignal.timeout(180000)
  const sub = ctx.get('subagents')
  if (sub?.startActivation) {
    const activation = await sub.startActivation({
      provider: 'spawn',
      label,
      request: {
        label,
        prompt: [{ type: 'text', text: prompt }],
        parent,
        signal: abortSignal,
        maxDepth: 1,
        // TS 的 SubagentStartRequest 没声明 toolFilter，但宿主运行时会读 request.toolFilter
        // 并落到 childCtx.tools.restrict(...)（app.asar 里 subagent manager 的 composition 那段），
        // 所以这里传是有效的 —— 别再当「多余字段」删掉。
        ...(allowTools ? { toolFilter: { allow: allowTools } } : {})
      },
      signal: abortSignal,
      delivery: 'caller' // 结果回调用方，不往父会话投完成通知
    })
    try {
      // 独立时间兜底：provider 不响应 abort 时，await result 会永远挂着，
      // 让 index.js 的 run-guard 永真、之后每轮 poll 直接 return（推送静默停摆）
      const res = await withTimeout(activation.result, 300_000, 'child result')
      const text = textFromChildResult(res)
      const childId = activation.childId || `sub-${randomUUID().slice(0, 8)}`
      const usage = resolveUsage(ctx, childId, activation)
      return { childId, text, usage, raw: safeJson(res) }
    } finally {
      try {
        await activation.dispose()
      } catch {}
    }
  }

  if (sub?.start) {
    const activation = await sub.start('spawn', {
      label,
      prompt: [{ type: 'text', text: prompt }],
      parent,
      signal: abortSignal,
      maxDepth: 1,
      ...(allowTools ? { toolFilter: { allow: allowTools } } : {})
    })
    try {
      const res = await withTimeout(activation.result, 300_000, 'child result')
      const text = textFromChildResult(res)
      const childId = activation.childId || `sub-${randomUUID().slice(0, 8)}`
      const usage = resolveUsage(ctx, childId, activation)
      return { childId, text, usage, raw: safeJson(res) }
    } finally {
      try {
        await activation.dispose()
      } catch {}
    }
  }

  // 退路：agents.create + followup
  const agents = ctx.get('agents')
  if (!agents?.create) {
    throw new Error('Neither subagents nor agents.create available')
  }

  const sessionId = `session-${randomUUID()}`
  const handle = await agents.create({
    sessionId,
    meta: {
      origin: 'subagent', // 侧栏隐藏
      parentSession: parent,
      isSeeded: true,
      cwd: process.cwd()
    },
    agentOptions: { maxTokens: 1000 },
    signal: signal || AbortSignal.timeout(60000)
  })

  try {
    const msg = {
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin:dsh-intel-pulse' }
    }
    if (handle.agent?.followup) {
      await handle.agent.followup(msg)
    } else {
      // 不投消息就永远读不到 assistant/message，只会报「(空回复)」把真因盖住
      throw new Error('agents.create 返回的句柄不支持 followup，无法把提示送进子会话')
    }
    if (handle.agent?.whenIdle) {
      await handle.agent.whenIdle()
    }

    let text = ''
    let usage = emptyUsage()
    if (handle.agent?.session) {
      const session = handle.agent.session
      usage = readSessionUsage(session)
      const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i]
        if (ev?.type === 'assistant/message' && ev?.data?.content) {
          text = Array.isArray(ev.data.content)
            ? ev.data.content.map(c => c.text || '').join('\n')
            : String(ev.data.content)
          break
        }
      }
    }

    return { childId: sessionId, text, usage }
  } finally {
    try {
      if (typeof handle.dispose === 'function') {
        await handle.dispose()
      }
    } catch {}
  }
}

function withTimeout(promise, ms, label) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

// 宿主要求 parent 是「真实的活 agent 对象」，传 sessionId 字符串会被拒：
// subagent creation requires the exact live parent agent
//
// 投递目标会话通常没开在内存里，agents.get 会返回 undefined —— 以前这里直接返回
// undefined，子会话创建必然失败，于是四种采集方法全部秒退回内置抓取。
// 现在按投递那边同样的办法：先 get、再 sessionController.resolveAgent、最后 agents.resume。
export async function acquireParentAgent(ctx, cfg) {
  const agents = ctx.get('agents')
  const noop = { parent: undefined, release: async () => {}, how: 'none' }
  if (!agents) return noop
  const ids = (Array.isArray(cfg.sessionIds) ? cfg.sessionIds : []).map(s => String(s || '').trim()).filter(Boolean)

  for (const id of ids) {
    try {
      const agent = typeof agents.get === 'function' ? agents.get(id) : undefined
      if (agent) return { parent: agent, release: async () => {}, how: 'live' }
    } catch {
      /* 单个会话取不到就先跳过 */
    }
  }

  // 没开着就用 sessionController.resolveAgent 打开它（GUI 点开会话同一条路）：
  // 归属在宿主侧，插件停用/重载都不会把这个会话摘掉，侧栏那一行也不会消失。
  const sc = ctx.get('sessionController')
  if (typeof sc?.resolveAgent === 'function') {
    for (const id of ids) {
      try {
        const r = await withTimeout(Promise.resolve(sc.resolveAgent(id)), 45000, 'resolveAgent parent')
        const agent = r?.agent ?? r
        if (agent?.session) return { parent: agent, release: async () => {}, how: 'resolved' }
      } catch {
        /* 换下一个会话再试 */
      }
    }
  }

  // 投递目标会话既没开着、也唤醒不了时，退一步用进程里任意一个活着的根 agent 当父会话：
  // 子会话只是借用它的运行时与工具，产出的内容与 token 记账都回收到插件自己这里。
  const liveRoot = () => pickLiveRootAgent(agents, ids)
  if (typeof agents.resume !== 'function') {
    const root = liveRoot()
    if (root) return { parent: root, release: async () => {}, how: 'live-root' }
  }

  if (typeof agents.resume === 'function') {
    for (const id of ids) {
      try {
        const handle = await withTimeout(
          Promise.resolve(agents.resume({ resumeSessionId: id })),
          45000,
          'resume parent'
        )
        const agent = handle?.agent ?? handle
        if (agent) {
          return {
            parent: agent,
            how: 'resumed',
            // 同样**不 dispose**：dispose 会把会话从 live registry 摘掉，GUI 侧栏那一行就没了
            // （见 lib/deliver.js 里的同款注释）。保持挂载反而让下次采集走 live 快路径。
            release: async () => {}
          }
        }
        try {
          await handle?.dispose?.()
        } catch {}
      } catch {
        /* 换下一个会话再试 */
      }
    }
  }

  const root = liveRoot()
  if (root) return { parent: root, release: async () => {}, how: 'live-root' }

  return noop
}

/** 从 agents.roots() / agents.list() 的返回值里挑出第一个可用的活 agent。 */
function firstAgentFrom(candidate, exclude) {
  if (!candidate) return undefined
  const list = []
  try {
    if (Array.isArray(candidate)) {
      list.push(...candidate)
    } else if (typeof candidate[Symbol.iterator] === 'function') {
      for (const it of candidate) list.push(it)
    } else if (typeof candidate.values === 'function') {
      for (const it of candidate.values()) list.push(it)
    }
  } catch {
    return undefined
  }
  for (const entry of list) {
    const agent = entry?.agent ?? entry
    if (!agent) continue
    const id = agent?.session?.id || agent?.id || ''
    if (id && exclude.includes(id)) continue
    return agent
  }
  return undefined
}

function pickLiveRootAgent(agents, exclude) {
  for (const name of ['roots', 'list']) {
    try {
      const out = typeof agents[name] === 'function' ? agents[name]() : undefined
      const agent = firstAgentFrom(out, exclude)
      if (agent) return agent
    } catch {
      /* 换下一个取法 */
    }
  }
  return undefined
}

const SKILL_ASSET = new URL('../assets/ego-search.SKILL.md', import.meta.url)
let skillScriptCache = null

/** 插件自带的那份 ego-search 脚本：脚本模式的依赖在插件里，跟用户本地的 skill 解耦。 */
function loadSkillScript() {
  if (skillScriptCache) return skillScriptCache
  let text = ''
  try {
    // asar 里用 fileURLToPath 比直接拿 file:// URL 稳
    const raw = fs.readFileSync(fileURLToPath(SKILL_ASSET), 'utf-8')
    const block = raw.match(/```(?:javascript|js)\r?\n([\s\S]*?)```/)
    text = (block ? block[1] : raw).trim()
  } catch {
    text = ''
  }
  if (!text) {
    // 空脚本塞进 prompt 只会让子会话空转、编造结果，还把真因埋进「没吐出合法 items」里
    throw Object.assign(new Error('ego-search.SKILL.md 读取失败或里面没有脚本代码块'), { stage: 'skill' })
  }
  skillScriptCache = text
  return text
}

/** 首页 / 导航页 / 面包屑标题都算抓错：这些条目对「离席简报」没有信息量。 */
function isHomepageUrl(url) {
  try {
    const u = new URL(url)
    return !u.pathname || u.pathname === '/' || u.pathname === ''
  } catch {
    return true
  }
}

function looksLikeNavTitle(title) {
  const text = String(title || '').replace(/\s+/g, ' ').trim()
  // 中文三字标题（「英伟达」「重磅消息」这类）不该被最小长度误杀，与内置抓取的判定保持一致
  const min = /[\u4e00-\u9fff]/.test(text) ? 3 : 4
  if (text.length < min) return true
  if (/https?:\/\//i.test(text)) return true
  if (/^[\w-]+(\.[\w-]+){1,3}(\s|$)/i.test(text)) return true      // 以域名开头
  if (/(›|»|〉|\s>\s)/.test(text) && /[\w-]+(\.[\w-]+){1,3}/i.test(text)) return true // 「域名 › 栏目」
  return false
}

/** 标题归一：去掉标点与空白，用来判断「两条其实是同一句话」。 */
function titleKey(title) {
  return String(title || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

/**
 * 过滤脏条目并去重：
 *  · 首页 / 导航页 / 面包屑标题 → 直接丢（CnGal 那种「站点名 + 站点名 › 栏目」就是这一类）
 *  · 同一个标题出现多次 → 只留路径最深的那条（更像文章页）
 *  · 截断到「每次推送条数」这么多条（详略档位只管摘要长短，不管条数）
 * 返回 { items, rejected }
 */
export function sanitizeChildItems(list, count = 3) {
  const want = Math.max(1, Number(count) || 3)
  const seenUrl = new Set()
  const candidates = []
  let rejected = 0

  for (const it of list) {
    const title = String(it.title || '').replace(/\s+/g, ' ').trim()
    const summary = String(it.summary || '').trim()
    const url = String(it.url || '').trim()
    // 投递文本已剥离 URL，以标题和摘要的信息量为准；仅拦截空标题与纯导航面包屑，不因根域名/首页链接误杀内容
    if (!title || looksLikeNavTitle(title)) { rejected++; continue }
    if (url) {
      const key = url.replace(/[?#].*$/, '').replace(/\/+$/, '')
      if (key && seenUrl.has(key)) { rejected++; continue }
      if (key) seenUrl.add(key)
    }
    let depth = 0
    try { depth = new URL(url).pathname.split('/').filter(Boolean).length } catch {}
    candidates.push({ item: { ...it, title, summary, url }, depth, key: titleKey(title) })
  }

  const bestByTitle = new Map()
  for (const c of candidates) {
    const prev = bestByTitle.get(c.key)
    if (!prev) {
      bestByTitle.set(c.key, c)
      continue
    }
    rejected++
    const cLen = (c.item.summary || '').length
    const pLen = (prev.item.summary || '').length
    if (cLen > pLen || (cLen === pLen && c.depth > prev.depth)) {
      bestByTitle.set(c.key, c)
    }
  }

  const picked = [...bestByTitle.values()].map(c => c.item)
  picked.sort((a, b) => (b.summary ? 1 : 0) - (a.summary ? 1 : 0))
  return { items: picked.slice(0, want), rejected }
}

export async function executeChildCollect(method, cfg, ctx, signal) {
  const interests = cfg.interests || []
  const interest = interests[Math.floor(Math.random() * interests.length)] || '科技进展'
  const dateStr = getLocalDayKey() // 用本地日期，别让 {date} 在半夜显示成昨天
  const query = (cfg.queryTemplate || '{interest} 今天 最新')
    .replace(/\{interest\}/g, interest)
    .replace(/\{date\}/g, dateStr)

  const depth = detailSpec(cfg.detail)
  // 条数只看「每次推送条数」；depth 只负责摘要长短
  const count = Math.max(1, Math.min(20, Number(cfg.maxEntriesPerRun) || 3))

  let allowTools = []
  let prompt = ''

  if (method === 'web_search') {
    allowTools = ['web_search']
    prompt = `请使用 web_search 工具搜索以下关键词，抓 ${count} 条最新的资讯动态：
关键词：${query}

只要和关键词直接相关、最近几天发生的新事；每条都要有可访问的文章链接。
${depth.depth}。
拿到结果后只输出 JSON，不要任何额外说明：
{
  "items": [
    { "title": "资讯标题", "summary": "摘要", "url": "来源链接" }
  ]
}`
  } else if (method === 'egoDirect') {
    // 常规 ego 流程：像平时联网检索那样，用 ego 语义工具多步读页面，不写脚本。
    const bingUrl = `https://cn.bing.com/search?q=${encodeURIComponent(query)}`
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`
    allowTools = ['ego_navigate', 'ego_snapshot', 'ego_read_element', 'ego_space_open', 'ego_status', 'ego_wait']
    prompt = `你是资讯采集子会话。请用常规 ego 浏览器流程检索关于「${query}」的最新资讯，不要写脚本、不要调用 ego_script。

执行步骤：
1. 先用 ego_navigate 打开 ${bingUrl}。如果工具报「任务空间未打开」，先 ego_space_open { name: "default" }，再重试 navigate。
2. 用 ego_snapshot 读页面结构，定位自然搜索结果（跳过「大家还在搜」「相关搜索」「图片/视频聚合」这类块）；再用 ego_read_element 逐条读出标题与摘要原文。
3. 如果 clean 的条目不够 ${count} 条、或摘要不到 ${depth.summaryMin} 字，就 ego_navigate 打开其中 1~3 条结果页，用 ego_snapshot + ego_read_element 读正文开头，把要点写进 summary。被验证码拦截时改开 ${googleUrl}。
4. 每条必须是「真实文章标题 + 文章内页链接」：标题里带域名、形如「域名 › 栏目」的面包屑、或链接指向网站首页的，一律丢弃重找。
5. 时效优先：优先 24~72 小时内发布的条目，宁缺毋滥。

内容要求：${depth.depth}；需要 ${count} 条。
最后只输出一个 JSON，不要任何解释文字：
{
  "items": [
    { "title": "资讯标题", "summary": "摘要", "url": "来源链接" }
  ]
}`
  } else if (method === 'egoSkill') {
    // 脚本模式：只用 ego_script 跑插件自带的单脚本，一步拿回列表（不依赖本地 skill 内容）。
    const script = loadSkillScript()
    allowTools = ['ego_script']
    prompt = `你是资讯采集子会话。用 ego_script 执行下面这段检索脚本（先把 kw 改成关键词），一次取回搜索结果列表；不要多步翻页面。
关键词（填进 kw 里的字符串）：${query}

脚本：
\`\`\`javascript
${script}
\`\`\`

执行要点：
1. 工具输出的文本里会有一行 @@DSH_RESULT@@{"ok":true,"engine":"bing","results":[...]}；把那行的 JSON 解析出来，results 就是候选条目（title/url/snippet）。
2. 如果那行是 {"ok":false}，说明脚本这次没取到干净结果：改一下选择器或换 Google 分支重跑一次，不要照抄脏数据。
3. 只保留「真实文章标题 + 文章内页链接」：标题里出现域名、或形如「域名 › 栏目」的面包屑、或链接是网站首页的，都算抓错，丢弃。
4. 内容要求：${depth.depth}；优先 ${count} 条，宁缺毋滥，不要拿导航页凑数。时效优先 24~72 小时内。
最后只输出一个 JSON，不要任何解释文字：
{
  "items": [
    { "title": "资讯标题", "summary": "摘要", "url": "来源链接" }
  ]
}`
  } else {
    throw new Error(`Unsupported child method: ${method}`)
  }

  const parentRef = await acquireParentAgent(ctx, cfg)
  if (!parentRef.parent) {
    const err = new Error('子会话无法创建：没有可用的活 agent 作为父会话（投递目标会话既未打开，也无法唤醒）')
    err.stage = 'parent'
    throw err
  }
  let childRes
  try {
    childRes = await runChild(ctx, {
      parent: parentRef.parent,
      prompt,
      allowTools,
      label: `away-notify-${method}`,
      signal
    })
  } catch (e) {
    const err = new Error(`子会话执行失败（parent=${parentRef.how}，tools=${allowTools.join('/') || '无'}）：${e?.message || e}`)
    err.stage = 'child'
    throw err
  } finally {
    await parentRef.release()
  }

  const payload = extractJsonPayload(childRes.text)
  if (!payload || !Array.isArray(payload.items) || payload.items.length === 0) {
    throw new Error(`子会话没吐出合法 items JSON（parent=${parentRef.how}，child=${childRes.childId}）：${String(childRes.text || '').slice(0, 300) || '(空回复)'} | raw=${String(childRes.raw || '').slice(0, 500)}`)
  }

  const rawItems = payload.items.map(it => ({
    title: String(it.title || '').trim(),
    summary: String(it.summary || '').trim(),
    url: String(it.url || '').trim(),
    source: `${method}`,
    score: 1
  }))

  const { items, rejected } = sanitizeChildItems(rawItems, count)
  // 允许被子会话少给一条：被清洗掉 1 条就整轮判失败会白烧一次子会话
  const minItems = Math.max(1, Math.min(2, count - 1))
  if (items.length < minItems) {
    // 只剩 0~1 条，多半是抓到了导航页；这算这次采集失败，让回退链换下一种方法。
    throw new Error(`Child returned too few usable items (${items.length}, rejected ${rejected}). Raw text: ${childRes.text.slice(0, 300)} | child=${childRes.childId}`)
  }

  return {
    ok: true,
    items,
    childId: childRes.childId,
    usage: childRes.usage
  }
}

// 清道夫
export async function cleanOldChildSessions(ctx, cfg) {
  if (!cfg.autoCleanChildren) return
  const retain = cfg.retainChildSessions || 5

  try {
    const runs = readAllRuns()
    // 同一个 childId 可能跑过多轮：先按会话去重，再按「最近使用」的顺序保留
    const childIds = [...new Set(runs.map(r => r.childId).filter(Boolean))]
    if (childIds.length <= retain) return

    const toClean = childIds.slice(0, childIds.length - retain)
    const agents = ctx.get('agents')
    const wsReg = ctx.get('workspaceRegistry')

    for (const cid of toClean) {
      // agents 注册表的 key 是 session-<uuid>，runs.jsonl 里存的是裸 uuid
      const full = String(cid).startsWith('session-') ? String(cid) : `session-${cid}`
      if (agents?.get && agents.get(full)) {
        continue // Still alive, skip
      }
      if (wsReg?.archiveSession) {
        try {
          await wsReg.archiveSession(full)
        } catch {}
      }
    }
  } catch {}
}
