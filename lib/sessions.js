// 工作区 / 会话清单：给设置卡片里的「投递到哪个会话」用。
//
// 数据来源（都是宿主自己的落盘文件，只读）：
//   - $DSH_HOME/storages/workspace.json                 → 工作区标题、工作区下的会话 id、
//                                                        被归档的会话 id（global.archivedSessionIds）
//   - $DSH_HOME/storages/session_projcache/sessions/*.json → 会话标题（rows.title.val）
//   - $DSH_HOME/storages/session_projcache.json         → 上面那份文件不存在时的退路
//   - ctx.sessions.list()（活的会话，含 header.cwd）      → 还没写进 workspace.json 的新会话
//
// 会话目录名带 session- 前缀，projcache 文件名没有，所以两边都归一化后再比。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// DSH_HOME 要到真正用的时候再算：模块可能在宿主设置好环境变量之前就被导入。
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function stripPrefix(id) {
  return String(id || '').replace(/^session-/, '')
}

function titleFromRecord(record) {
  const row = record?.rows?.title ?? record?.title
  const val = row?.val
  return typeof val === 'string' && val.trim() ? val.trim() : null
}

// 会话标题表：键使用去掉 session- 前缀的 id，方便和目录名/文件名对齐。
// 这个函数会把整个 projcache 目录（几百个文件）读一遍，而设置页的会话选择器、
// 每次推送的 IM 同步都会调它，所以结果缓存 30 秒。
let titlesCache = { at: 0, map: new Map() }

export function loadSessionTitles({ maxAgeMs = 30000 } = {}) {
  const now = Date.now()
  if (titlesCache.map.size > 0 && now - titlesCache.at < maxAgeMs) {
    return titlesCache.map
  }
  const titles = new Map()
  const dir = path.join(dshHome(), 'storages', 'session_projcache', 'sessions')
  try {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      const id = stripPrefix(file.slice(0, -'.json'.length))
      const record = readJson(path.join(dir, file), null)
      const title = titleFromRecord(record?.record ?? record)
      if (title && !titles.has(id)) titles.set(id, title)
    }
  } catch {}
  if (titles.size === 0) {
    const raw = readJson(path.join(dshHome(), 'storages', 'session_projcache.json'), null)
    const walk = (node) => {
      if (!node || typeof node !== 'object') return
      for (const [key, value] of Object.entries(node)) {
        if (value && typeof value === 'object') {
          const title = titleFromRecord(value?.record ?? value)
          const id = stripPrefix(key)
          if (title && !titles.has(id)) titles.set(id, title)
          walk(value)
        }
      }
    }
    walk(raw)
  }
  if (titles.size > 0) titlesCache = { at: now, map: titles }
  return titles
}

// 会话最近活动时间：projcache 文件的 mtime 最接近「上次聊过」的时刻。
function loadSessionActivity() {
  const at = new Map()
  const dir = path.join(dshHome(), 'storages', 'session_projcache', 'sessions')
  try {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      try {
        at.set(stripPrefix(file.slice(0, -'.json'.length)), fs.statSync(path.join(dir, file)).mtimeMs)
      } catch {}
    }
  } catch {}
  return at
}

function loadWorkspaces() {
  const raw = readJson(path.join(dshHome(), 'storages', 'workspace.json'), null)
  const archived = new Set(
    (Array.isArray(raw?.global?.archivedSessionIds) ? raw.global.archivedSessionIds : []).map(stripPrefix)
  )
  const out = []
  const table = raw?.tables?.workspaces
  if (table && typeof table === 'object') {
    for (const [id, ws] of Object.entries(table)) {
      if (!ws || typeof ws !== 'object') continue
      const sessionIds = Array.isArray(ws.sessionIds) ? ws.sessionIds : []
      out.push({
        id,
        title: String(ws.title || path.basename(String(ws.path || '')) || '未命名工作区'),
        path: String(ws.path || ''),
        sessionIds: sessionIds.filter((sid) => !archived.has(stripPrefix(sid)))
      })
    }
  }
  return { workspaces: out, archived }
}

function cwdWorkspaceTitle(cwd) {
  const base = path.basename(String(cwd || ''))
  return base || '未命名工作区'
}

/**
 * 列出所有工作区与其中的会话，按最近活动时间倒序。
 * @param {{ live?: Array<{ id?: string, header?: { cwd?: string } }> }} [options]
 */
export function listWorkspaces(options = {}) {
  const titles = loadSessionTitles()
  const activity = loadSessionActivity()
  const { workspaces, archived } = loadWorkspaces()
  const seen = new Set()
  const out = []

  for (const ws of workspaces) {
    const sessions = []
    for (const sid of ws.sessionIds) {
      const norm = stripPrefix(sid)
      if (seen.has(norm)) continue
      seen.add(norm)
      sessions.push({
        id: String(sid),
        title: titles.get(norm) || titles.get(sid) || null,
        updatedAt: activity.get(norm) || activity.get(sid) || null
      })
    }
    sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    out.push({ id: ws.id, title: ws.title, path: ws.path, sessions })
  }

  // 活会话：新开的会话可能还没写进 workspace.json，按 cwd 归到同名工作区，没有就补一个。
  const live = Array.isArray(options.live) ? options.live : []
  for (const session of live) {
    const id = String(session?.id || '')
    if (!id) continue
    const norm = stripPrefix(id)
    if (seen.has(norm) || archived.has(norm)) continue
    seen.add(norm)
    const cwd = String(session?.header?.cwd || '')
    let target = cwd ? out.find((w) => w.path && path.resolve(w.path) === path.resolve(cwd)) : undefined
    if (!target) {
      target = { id: 'live:' + (cwd || id), title: cwd ? cwdWorkspaceTitle(cwd) : '当前会话', path: cwd, sessions: [] }
      out.push(target)
    }
    target.sessions.unshift({
      id: String(id),
      title: titles.get(norm) || titles.get(id) || null,
      updatedAt: activity.get(norm) || activity.get(id) || Date.now()
    })
  }

  // 只保留还有会话的工作区；工作区之间按「最近一个会话的活动时间」排序。
  const kept = out
    .filter((w) => w.sessions.length > 0)
    .map((w) => ({ ...w, latest: w.sessions[0]?.updatedAt || 0 }))
    .sort((a, b) => b.latest - a.latest)
    .map(({ latest, ...w }) => w)

  return {
    workspaces: kept,
    sessionCount: kept.reduce((n, w) => n + w.sessions.length, 0)
  }
}
