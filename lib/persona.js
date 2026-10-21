// 人设检测与「按人设写推送」。
//
// 为什么要「检测」而不是「配置具体插件」：
// 任何给人设的插件（官方 @deepseek-ai/dsh-persona、whale-persona、以及以后别人写的）
// 最终都做同一件事——往 system prompt 里挂一段人设正文。所以这里只认「装配后的段落」，
// 只要出现名字像人设、正文又足够长的段落，就认为当前这台机器上的人设在生效。
// 没有这类插件时返回 active:false，投递就退回纯信息，不套任何问候语。
import { runChild, acquireParentAgent } from './child.js'
import { detailSpec } from './config.js'

const PERSONA_RE = /persona|人设|人格|角色设定|character|roleplay|role-?card|waifu|companion|whale/i
// 段落名字对上还不够：没配置人设时插件照样会注册段落，只是正文是空的。
// 中文人设正文很短也能说明问题，所以阈值只用来区分「空 / 没写」。
const MIN_PERSONA_CHARS = 8
// 官方 deployment:persona-prefix 槽位的默认正文就是这句。它一直在，但不代表有人设，
// 人设插件的做法是「占同一个槽位、把正文换掉」。所以这句原样出现时判为「没人设」。
const HARNESS_DEFAULT_RE = /^You are a coding agent powered by/i

function isPersonaSection(section) {
  const name = String(section?.name || '')
  if (!PERSONA_RE.test(name)) return false
  const text = String(section?.text || '').replace(/\s+/g, ' ').trim()
  if (text.length < MIN_PERSONA_CHARS) return false
  if (HARNESS_DEFAULT_RE.test(text)) return false
  return true
}

/**
 * 当前宿主里是否真的有人设在生效。
 * @returns {Promise<{active:boolean, names:string[], chars:number, sectionCount?:number, reason?:string}>}
 */
async function withTimeout(promise, ms, label) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer) })
}

export async function detectPersona(ctx) {
  const sp = ctx.get('systemPrompt')
  if (!sp || typeof sp.assemble !== 'function') {
    return { active: false, names: [], chars: 0, reason: 'systemPrompt 服务不可用' }
  }
  try {
    // assemble 没有超时，插件装配慢的时候会把整条推送挂在这里；
    // 人设只是「锦上添花」，4 秒拿不到就当没有。
    const assembly = await withTimeout(Promise.resolve(sp.assemble({})), 4000, 'systemPrompt.assemble')
    const sections = Array.isArray(assembly?.sections) ? assembly.sections : []
    const hits = sections.filter(isPersonaSection)
    return {
      active: hits.length > 0,
      names: hits.map(s => String(s.name)),
      chars: hits.reduce((n, s) => n + String(s.text || '').trim().length, 0),
      sectionCount: sections.length
    }
  } catch (e) {
    return { active: false, names: [], chars: 0, reason: String(e?.message || e) }
  }
}

/**
 * 让「带人设的子会话」自己写这条推送。
 * 子会话继承父会话的 system prompt（人设段也在里面），所以它写出来的语气、称呼、
 * 开场与收尾天然就是人设的样子，插件这边不需要认识具体是哪个插件、也不需要抄人设正文。
 * @returns {Promise<{text:string, usage:object|null, childId:string|null}|null>}
 */
export async function composeInPersona(ctx, cfg, items, signal) {
  const list = Array.isArray(items) ? items : []
  if (list.length === 0) return null
  // 合成这一步没有外部 signal（投递链路里不传），自己给一个超时；
  // 传 undefined 下去会让宿主的子会话创建直接炸在 signal.throwIfAborted()。
  const sig = signal || AbortSignal.timeout(120000)

  const detail = ['low', 'medium', 'high'].includes(cfg.detail) ? cfg.detail : 'medium'
  const spec = detailSpec(detail)
  const budget = detail === 'high' ? 400 : detail === 'medium' ? 200 : 100
  const lines = list.slice(0, Math.max(1, Math.min(20, Number(cfg.maxEntriesPerRun) || 3))).map((it, idx) => {
    // prompt 里说「链接已经去掉」，那就真去掉：否则模型会把 URL 抄进正文，
    // 而且空标题会留出「标题：」这种半截行。
    const title = String(it?.title || '').replace(/https?:\/\/\S+/g, '').trim()
    if (!title) return null
    const summary = String(it?.summary || '').replace(/https?:\/\/\S+/g, '').trim().slice(0, spec.summaryMax || 200)
    return `${idx + 1}. 标题：${title}${summary ? '\n   摘要：' + summary : ''}`
  }).filter(Boolean).join('\n')
  if (!lines) return null

  const prompt = [
    '你刚替用户扫了一遍外面的新消息，现在要主动给他推一条。下面是整理好的条目（链接已经去掉）：',
    lines,
    '',
    '要求：',
    '1. 用你自己的说话方式写：称呼、语气、开场和收尾都按你平时对他的风格来，不要套用固定的寒暄模板，也不要解释你在做什么。',
    '2. 只输出要发出去的那段正文，不要标题层级、不要额外说明。',
    '3. 不要出现任何网址、链接或来源括号。',
    `4. 详略按这一档：${spec.depth}；整段不超过 ${budget} 字。`,
    '5. 不要编造条目里没有的信息。'
  ].join('\n')

  const parentRef = await acquireParentAgent(ctx, cfg)
  if (!parentRef?.parent) {
    const e = new Error('没有可用的父会话，拿不到人设')
    e.code = 'no-parent'
    throw e
  }
  try {
    // 这里刻意不传 allowTools：空数组会被宿主当成「一个工具都不许用」而拒绝创建子会话。
    // 提示词已经要求它只写正文、不要去查东西。
    const res = await runChild(ctx, {
      parent: parentRef.parent,
      prompt,
      label: 'away-notify-persona',
      signal: sig
    })
    const text = String(res?.text || '').trim()
    if (!text) {
      const e = new Error('人设子会话没有返回正文')
      e.code = 'empty-child'
      throw e
    }
    return { text, usage: res.usage || null, childId: res.childId || null }
  } finally {
    try { await parentRef.release?.() } catch {}
  }
}
