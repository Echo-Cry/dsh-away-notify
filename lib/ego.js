import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import fs from 'node:fs'
import { join, dirname } from 'node:path'
import { getLocalDayKey } from './state.js'

const profileDir = process.env.DSH_PROFILE_DIR
  ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'desktop')
let req = null
try {
  req = createRequire(join(profileDir, 'package.json'))
} catch {}

async function tryLoad(spec) {
  if (!req) return null
  try {
    return await import(pathToFileURL(req.resolve(spec)).href)
  } catch {
    return null
  }
}

const SENTINEL = '@@DSH_RESULT@@' // 14 字符

function readAll(stream) {
  if (!stream) return ''
  // 宿主 SubprocessOutputReader：readFrom(offset) 非消费式读取
  if (typeof stream.readFrom === 'function') {
    try {
      return String(stream.readFrom(0)?.text || '')
    } catch {
      return ''
    }
  }
  if (typeof stream === 'string') return stream
  if (Buffer.isBuffer(stream)) return stream.toString('utf-8')
  if (Array.isArray(stream)) {
    return stream.map(c => typeof c === 'string' ? c : Buffer.isBuffer(c) ? c.toString('utf-8') : '').join('')
  }
  return ''
}

function parseSentinel(stdout) {
  if (!stdout) return null
  const idx = stdout.lastIndexOf(SENTINEL)
  if (idx === -1) return null
  const raw = stdout.slice(idx + SENTINEL.length).trim()
  try {
    const firstLine = raw.split(/\r?\n/)[0]
    return JSON.parse(firstLine)
  } catch {
    return null
  }
}

// 自带的解析（dsh-ego-browser 的 resolveEgoEnv 有时导不进来，这里等价复刻一份）
function findChromeBinary() {
  if (process.env.EGO_LINUX_CHROME) return process.env.EGO_LINUX_CHROME
  const pf = process.env.ProgramFiles
  const pfx86 = process.env['ProgramFiles(x86)']
  const local = process.env.LOCALAPPDATA
  const candidates = [
    pf && join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    pfx86 && join(pfx86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local && join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    pf && join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    pfx86 && join(pfx86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    local && join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ].filter(Boolean)
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p
    } catch {}
  }
  return null
}

function localResolveEnv(opts = {}) {
  const env = { ...process.env }
  if (process.versions.electron && env.ELECTRON_RUN_AS_NODE === undefined) env.ELECTRON_RUN_AS_NODE = '1'
  const chromePath = opts.chromePath || findChromeBinary()
  if (env.EGO_LINUX_CHROME === undefined && chromePath) env.EGO_LINUX_CHROME = chromePath
  const args = opts.chromeArgs || '--window-position=5000,5000'
  if (env.EGO_LINUX_EXTRA_ARGS === undefined) env.EGO_LINUX_EXTRA_ARGS = args
  if (env.EGO_ISOLATE_SPACES === undefined) env.EGO_ISOLATE_SPACES = '0'
  return env
}

// 从包的入口文件往上找到真正的包根目录（main 可能是 lib/index.js）
function findPackageRoot(entryFile, marker) {
  let dir = dirname(entryFile)
  for (let i = 0; i < 6; i++) {
    try {
      if (marker && fs.existsSync(join(dir, marker))) return dir
      const pkgFile = join(dir, 'package.json')
      if (fs.existsSync(pkgFile)) {
        const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
        if (pkg && pkg.name === 'dsh-ego-browser') return dir
      }
    } catch {}
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

export async function resolveEgo(ctx, cfg = {}) {
  const mod = await tryLoad('dsh-ego-browser')
  let pkgRoot = null
  try {
    if (req) {
      let entry = null
      try {
        entry = req.resolve('dsh-ego-browser/package.json')
        pkgRoot = dirname(entry)
      } catch {}
      if (!pkgRoot) {
        entry = req.resolve('dsh-ego-browser')
        pkgRoot = findPackageRoot(entry, join('runtime', 'ego-linux', 'bin', 'ego-browser.mjs'))
      }
    }
  } catch {}

  const egoBin = cfg.ego?.egoBin
    || (pkgRoot && join(pkgRoot, 'runtime', 'ego-linux', 'bin', 'ego-browser.mjs'))
    || 'ego-browser'

  const chromeArgs = cfg.ego?.chromeArgs || '--window-position=5000,5000'
  const env = mod?.resolveEgoEnv
    ? mod.resolveEgoEnv({ chromeArgs, chromePath: cfg.ego?.chromePath, isolateSpaces: false })
    : localResolveEnv({ chromeArgs, chromePath: cfg.ego?.chromePath })

  return {
    egoBin,
    env,
    hasRuntime: Boolean(pkgRoot),
    mod
  }
}

export async function runEgoScript(ctx, ego, script, { timeoutMs = 90000, signal } = {}) {
  const sub = ctx.get('subprocess')
  if (!sub?.spawn) {
    return { ok: false, error: 'subprocess service unavailable' }
  }

  try {
    const handle = sub.spawn({
      argv: [process.execPath, ego.egoBin],
      cwd: process.cwd(),
      env: ego.env,
      stdio: {
        stdin: { data: script },
        stdout: { maxBytes: 4 << 20 },
        stderr: { maxBytes: 512 << 10 }
      },
      graceMs: timeoutMs,
      ...(signal ? { signal } : {})
    })

    const outcome = await handle.done
    const stdout = readAll(handle.collected?.stdout)
    const stderr = readAll(handle.collected?.stderr)

    if (outcome && outcome.exitCode !== 0) {
      return { ok: false, error: `ego exited ${outcome.exitCode}\n${stderr.slice(-2000)}` }
    }

    const payload = parseSentinel(stdout)
    if (!payload) {
      return { ok: false, error: `no ${SENTINEL} payload\n${stderr.slice(-2000)}` }
    }

    return { ok: true, value: payload }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

export async function stopEgoBrowser(ctx, ego) {
  const sub = ctx.get('subprocess')
  if (!sub?.spawn) return { ok: false, error: 'subprocess unavailable' }

  try {
    const handle = sub.spawn({
      argv: [process.execPath, ego.egoBin, '--stop'],
      cwd: process.cwd(),
      env: ego.env,
      stdio: { stdin: { data: '' }, stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } },
      graceMs: 8000
    })
    await handle.done
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

export async function checkEgoStatus(ctx, ego) {
  const sub = ctx.get('subprocess')
  if (!sub?.spawn) return { running: false, available: false }

  try {
    const handle = sub.spawn({
      argv: [process.execPath, ego.egoBin, '--status'],
      cwd: process.cwd(),
      env: ego.env,
      stdio: { stdin: { data: '' }, stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } },
      graceMs: 5000
    })
    await handle.done
    const stdout = readAll(handle.collected?.stdout)
    const running = /running|attached|pid/i.test(stdout)
    return { running, available: true, stdout }
  } catch {
    return { running: false, available: false }
  }
}

export function buildEgoSearchScript(kw) {
  return `
const kw = ${JSON.stringify(kw)};
let ok = false;
// 这个自带的 ego runtime 不会自动开窗口：先建一个空标签页再导航
try { if (ego && typeof ego.createTab === 'function') await ego.createTab('about:blank') } catch (_) {}

// —— 结果清洗：只保留「真正的标题」 ——
// 背景：Bing 现版每条结果顶部有一个 <div class="b_tpcn"><a class="tilk">域名 + 面包屑URL</a></div>，
// 它排在 <h2> 之前。旧选择器 'h2 a, a[href]' 按文档顺序命中，取到的是这个站点标识块，
// 于是标题变成「域名\\nhttps://域名」，snippet 却正常 —— 这正是脏标题的成因。
const squash = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
const looksLikeBareDomainOrCrumb = (t) => {
  if (/\\s·\\s/.test(t) && /^[a-z0-9][a-z0-9.-]*\\.[a-z]{2,}\\s·/i.test(t)) return true; // 域名 · 面包屑
  return /^[a-z0-9][a-z0-9.-]*\\.[a-z]{2,}$/i.test(t); // 光秃秃一个域名
};
const accept = (r) => {
  if (!r.title || !r.url) return false;
  if (r.title.length < 4 || r.title.length > 180) return false;
  if (looksLikeBareDomainOrCrumb(r.title)) return false;
  return true;
};

try {
  await page.goto('https://cn.bing.com/search?q=' + encodeURIComponent(kw), { waitUntil: 'domcontentloaded', timeout: 12000 });
  try { await page.waitForSelector('#b_results > li.b_algo h2', { timeout: 6000 }) } catch (_) {}
  const raw = await page.evaluate(() => Array.from(document.querySelectorAll('#b_results > li.b_algo')).slice(0, 10).map(li => {
    // 标题：优先 h2 自身文本（不是 h2 里的 a —— a 会被 b_tpcn 的同名链接抢先），落 h3
    const h2 = li.querySelector('h2');
    const h3 = li.querySelector('h3');
    const titleEl = (h2 && h2.innerText && h2.innerText.trim()) ? h2 : h3;
    // 链接：标题链接 > 站点标识链接 > cite > 任意链接
    const a = (h2 && h2.querySelector('a')) || (h3 && h3.querySelector('a')) || li.querySelector('cite a') || li.querySelector('.b_tpcn a.tilk') || li.querySelector('a[href]');
    const s = li.querySelector('.b_caption p, .b_caption, .b_algoSlug, .b_lineclamp2, .b_lineclamp3, .b_snippet, p');
    return { title: titleEl ? titleEl.innerText : '', url: a ? a.href : '', snippet: s ? s.innerText : '' };
  }));
  const list = raw.map(r => ({ title: squash(r.title), url: r.url, snippet: squash(r.snippet) })).filter(accept);
  if (list.length) { console.log('${SENTINEL}' + JSON.stringify({ ok: true, engine: 'bing', results: list })); ok = true; }
} catch (_) {}

if (!ok) {
  try {
    await page.goto('https://www.google.com/search?q=' + encodeURIComponent(kw), { waitUntil: 'domcontentloaded', timeout: 12000 });
    const raw = await page.evaluate(() => {
      if (document.querySelector('#captcha-form, #recaptcha') || location.pathname.includes('/sorry/')) return null;
      return Array.from(document.querySelectorAll('div.g, div[data-sncf], .tF2Cxc')).slice(0, 10).map(el => {
        const h3 = el.querySelector('h3');
        const a = (h3 && h3.parentElement) || el.querySelector('a');
        const s = el.querySelector('.VwiC3b, div[style*="-webkit-line-clamp"], .yXK7lf');
        return { title: h3 ? h3.innerText : '', url: a ? a.href : '', snippet: s ? s.innerText : '' };
      });
    });
    const list = raw ? raw.map(r => ({ title: squash(r.title), url: r.url, snippet: squash(r.snippet) })).filter(accept) : [];
    if (list.length) { console.log('${SENTINEL}' + JSON.stringify({ ok: true, engine: 'google', results: list })); ok = true; }
  } catch (_) {}
}

if (!ok) console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'EMPTY_OR_BLOCKED' }));
`
}

export async function executeEgoDirect(cfg, ctx, signal) {
  const ego = await resolveEgo(ctx, cfg)
  const interests = cfg.interests || []
  const interest = interests[Math.floor(Math.random() * interests.length)] || '科技热点'
  const dateStr = getLocalDayKey() // 用本地日期，别让 {date} 在半夜显示成昨天
  const query = (cfg.queryTemplate || '{interest} 今天 最新')
    .replace(/\{interest\}/g, interest)
    .replace(/\{date\}/g, dateStr)

  const script = buildEgoSearchScript(query)
  const timeoutMs = (cfg.ego?.timeoutSec || 90) * 1000

  const res = await runEgoScript(ctx, ego, script, { timeoutMs, signal })
  let browserStopped = false

  if (cfg.ego?.closeBrowserAfterRun) {
    try {
      await stopEgoBrowser(ctx, ego)
      browserStopped = true
    } catch {}
  }

  if (!res.ok) {
    return { ok: false, error: res.error, browserStopped }
  }

  if (!res.value?.ok) {
    return { ok: false, error: res.value?.reason || 'search failed', browserStopped }
  }

  const rawResults = res.value?.results || []
  const items = rawResults.map(r => ({
    title: String(r.title || '').replace(/\s+/g, ' ').trim(),
    summary: r.snippet || '',
    url: r.url,
    source: `egoDirect (${res.value.engine || 'web'})`,
    score: 1
  })).filter(it => it.title && it.url && it.title.length >= 4)

  // 质量闸门：脚本式直连一旦抓到改版/反爬页面，就会给出「域名 + 面包屑」这种脏标题。
  // 条目不够时主动判失败，让 collect 的 fallbackChain 升级到 egoSkill（子会话 + ego_* 工具，语义抓取）。
  const need = Math.max(2, Math.min(cfg.maxEntriesPerRun || 2, 3))
  if (items.length < need) {
    return {
      ok: false,
      error: `egoDirect 直连结果不足（${items.length}/${need} 条通过清洗），升级到语义抓取`,
      browserStopped
    }
  }

  return { ok: true, items: items.slice(0, cfg.maxEntriesPerRun || 2), browserStopped }
}
