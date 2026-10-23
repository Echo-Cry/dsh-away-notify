// OneBot 11 / NapCat 原生出站与连接探测
// 使得资讯推送插件能够直接通过 OneBot 11 HTTP / WebSocket API 将消息投递到 QQ 私聊或群聊，
// 无需依赖会话活动状态（避免会话 retired 导致的消息阻断），零第三方依赖。
import { readFileSync, writeFileSync, copyFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir, platform } from 'node:os'
import { execSync } from 'node:child_process'

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

/**
 * 自动探测本地或默认的 OneBot 11 配置：
 * 1. 尝试从 NapCat 配置文件探测（例如 D:/NapCat.Shell/config/onebot11_*.json 或 ~/.dsh/media/onebot）
 * 2. 尝试从 dsh-onebot-qq 的 cordis 配置中探测
 * 3. 兜底默认值：http://127.0.0.1:3000
 */
export function detectOneBotHttpEndpoint() {
  // 1. 常见 NapCat 路径探测
  const candidateDirs = [
    join(dshHome(), 'media', 'onebot'),
    'D:\\NapCat.Shell\\config',
    'C:\\NapCat.Shell\\config',
    join(homedir(), 'NapCat.Shell', 'config')
  ]

  for (const dir of candidateDirs) {
    if (!existsSync(dir)) continue
    try {
      const files = ['onebot11.json', 'onebot11_2641684214.json']
      for (const f of files) {
        const full = join(dir, f)
        if (!existsSync(full)) continue
        const cfg = readJsonSafe(full)
        if (cfg?.network?.httpServers && Array.isArray(cfg.network.httpServers)) {
          const srv = cfg.network.httpServers.find(s => s.enable !== false)
          if (srv) {
            const host = srv.host || '127.0.0.1'
            const port = srv.port || 3000
            const token = srv.token || ''
            return {
              url: `http://${host}:${port}`,
              token,
              detected: true,
              source: full
            }
          }
        }
      }
    } catch {}
  }

  // 2. 默认标准 OneBot 11 HTTP 端口（NapCat / Go-CQHttp 官方标准端口为 3000）
  return {
    url: 'http://127.0.0.1:3000',
    token: '',
    detected: false,
    source: 'default'
  }
}

/**
 * 测试 OneBot 11 HTTP 服务是否存活以及鉴权状态
 */
export async function probeOneBotHttp(endpoint = {}) {
  const url = (endpoint.url || 'http://127.0.0.1:3000').replace(/\/+$/, '')
  const token = endpoint.token || ''

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)

  try {
    const headers = { 'Content-Type': 'application/json' }
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    const res = await fetch(`${url}/get_version_info`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
      signal: controller.signal
    })

    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}: ${res.statusText}`, statusCode: res.status }
    }

    const data = await res.json()
    if (data && (data.status === 'ok' || data.retcode === 0)) {
      return { ok: true, versionInfo: data.data || {} }
    }
    return { ok: false, error: data?.msg || `retcode: ${data?.retcode}` }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 通过 OneBot 11 HTTP API 发送消息（支持群聊与私聊）
 * @param {object} endpoint { url: string, token: string }
 * @param {object} params { messageType: 'private'|'group', targetId: string|number, text: string }
 */
export async function sendOneBotMessage(endpoint, { messageType, targetId, text }) {
  const baseUrl = (endpoint.url || 'http://127.0.0.1:3000').replace(/\/+$/, '')
  const token = endpoint.token || ''
  const isGroup = messageType === 'group'
  const action = isGroup ? 'send_group_msg' : 'send_private_msg'

  const targetNum = Number(targetId)
  if (!Number.isFinite(targetNum)) {
    throw new Error(`无效的 QQ 目标账号或群号: ${targetId}`)
  }

  const payload = {
    [isGroup ? 'group_id' : 'user_id']: targetNum,
    message: text
  }

  const headers = { 'Content-Type': 'application/json' }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)

  try {
    const res = await fetch(`${baseUrl}/${action}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    })

    if (!res.ok) {
      throw new Error(`OneBot HTTP 返回异常状态: ${res.status} ${res.statusText}`)
    }

    const data = await res.json()
    if (data.status === 'ok' || data.retcode === 0) {
      const messageId = data?.data?.message_id !== undefined ? String(data.data.message_id) : null
      return { ok: true, messageId }
    }
    throw new Error(`OneBot 发送失败 (retcode ${data.retcode}): ${data.message || data.wording || data.msg || '未知错误'}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 自动定位本机 NapCat 安装目录
 * @param {string} [customPath] 用户手动指定的路径
 * @returns {string|null} NapCat 根目录
 */
export function locateNapCatInstallation(customPath) {
  if (customPath && typeof customPath === 'string') {
    const trimmed = customPath.trim()
    if (existsSync(trimmed)) {
      if (existsSync(join(trimmed, 'config'))) return trimmed
      if (existsSync(join(trimmed, '..', 'config'))) return join(trimmed, '..')
    }
  }

  // 1. 环境变量
  const envCandidates = [process.env.NAPCAT_PATH, process.env.NAPCAT_DIR, process.env.NAPCAT_ROOT].filter(Boolean)
  for (const c of envCandidates) {
    if (existsSync(c) && existsSync(join(c, 'config'))) return c
  }

  // 2. 检查系统当前运行中的 NapCat 进程
  try {
    if (platform() === 'win32') {
      const psScript = '(Get-Process -Name *napcat* -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path)'
      const out = execSync(`powershell -NoProfile -Command "${psScript}"`, { encoding: 'utf8', timeout: 3000 }).trim()
      if (out) {
        const firstLine = out.split(/\r?\n/)[0].trim()
        if (firstLine && existsSync(firstLine)) {
          const dir = dirname(firstLine)
          if (existsSync(join(dir, 'config'))) return dir
        }
      }
    } else {
      const out = execSync('pgrep -a napcat 2>/dev/null || ps aux | grep -i napcat | grep -v grep', { encoding: 'utf8', timeout: 3000 }).trim()
      if (out) {
        const matches = out.match(/\/(?:[^\s"']+\/)+napcat[^\s"']*/i)
        if (matches && matches[0] && existsSync(matches[0])) {
          const dir = dirname(matches[0])
          if (existsSync(join(dir, 'config'))) return dir
        }
      }
    }
  } catch {}

  // 3. 常见默认目录
  const home = homedir()
  const commonDirs = [
    'D:\\NapCat.Shell',
    'C:\\NapCat.Shell',
    'E:\\NapCat.Shell',
    join(home, '.napcat'),
    join(home, 'NapCat'),
    join(home, 'NapCat.Shell'),
    join(home, 'napcat'),
    'C:\\Program Files\\NapCat',
    'C:\\Program Files (x86)\\NapCat',
    '/opt/napcat'
  ]

  for (const dir of commonDirs) {
    if (existsSync(dir) && existsSync(join(dir, 'config'))) {
      return dir
    }
  }

  return null
}

/**
 * 获取 NapCat 的所有 onebot11 配置文件路径
 */
export function getNapCatConfigFiles(napcatDir) {
  if (!napcatDir) return []
  const cfgDir = join(napcatDir, 'config')
  if (!existsSync(cfgDir)) return []
  try {
    const list = readdirSync(cfgDir)
    return list
      .filter(f => f.startsWith('onebot11') && f.endsWith('.json') && !f.endsWith('.bak'))
      .map(f => join(cfgDir, f))
  } catch {
    return []
  }
}

/**
 * 完整检测 NapCat 运行与配置状态
 * @returns {Promise<{
 *   status: 'running' | 'configured_need_restart' | 'not_configured' | 'not_found' | 'no_config',
 *   message: string,
 *   napcatDir?: string,
 *   configFiles?: string[],
 *   versionInfo?: object,
 *   httpUrl?: string
 * }>}
 */
export async function inspectNapCatStatus(options = {}) {
  const url = (options.url || 'http://127.0.0.1:3000').replace(/\/+$/, '')
  const token = options.token || ''
  const customPath = options.customPath || ''

  // 1. 先探测 HTTP 接口是否已经就绪运行
  const probe = await probeOneBotHttp({ url, token })
  if (probe.ok) {
    return {
      status: 'running',
      message: 'OneBot 11 HTTP 服务正常运行中',
      httpUrl: url,
      versionInfo: probe.versionInfo || {}
    }
  }

  // 2. 若未通，定位本机 NapCat 安装
  const napcatDir = locateNapCatInstallation(customPath)
  if (!napcatDir) {
    return {
      status: 'not_found',
      message: '未检测到 NapCat 安装目录，可手动指定 NapCat 路径',
      httpUrl: url,
      lastError: probe.error
    }
  }

  // 3. 读取配置文件
  const configFiles = getNapCatConfigFiles(napcatDir)
  if (configFiles.length === 0) {
    return {
      status: 'no_config',
      napcatDir,
      message: '检测到 NapCat 目录，但尚未找到 onebot11 配置文件',
      httpUrl: url
    }
  }

  // 4. 解析配置，检查是否已配置 HTTP 服务，并提取配置的真实端口与 Token
  let hasEnabledHttp = false
  let detectedPort = 3000
  let detectedToken = ''
  for (const file of configFiles) {
    const json = readJsonSafe(file)
    const servers = json?.network?.httpServers
    if (Array.isArray(servers) && servers.length > 0) {
      const active = servers.find(s => s.enable !== false) || servers[0]
      if (active) {
        hasEnabledHttp = active.enable !== false
        if (active.port) detectedPort = Number(active.port) || 3000
        if (typeof active.token === 'string') detectedToken = active.token.trim()
        break
      }
    }
  }

  const detectedUrl = `http://127.0.0.1:${detectedPort}`

  // 若用户传入的 url 不通（例如用户误填了 6099 WebUI 端口），尝试探测配置文件里实际配的 detectedUrl
  if (detectedUrl !== url) {
    const detectedProbe = await probeOneBotHttp({ url: detectedUrl, token: detectedToken || token })
    if (detectedProbe.ok) {
      return {
        status: 'running',
        message: 'OneBot 11 HTTP 服务正常运行中（已自动纠正为实际服务端口）',
        httpUrl: detectedUrl,
        accessToken: detectedToken,
        napcatDir,
        configFiles,
        versionInfo: detectedProbe.versionInfo || {},
        portMismatch: true,
        userUrl: url
      }
    }
  }

  if (hasEnabledHttp) {
    return {
      status: 'configured_need_restart',
      napcatDir,
      configFiles,
      httpUrl: detectedUrl,
      accessToken: detectedToken,
      message: `已在 NapCat 配置文件中检测到 HTTP ${detectedPort} 服务配置，但服务尚未响应（需启动或重启 NapCat 生效）`
    }
  }

  return {
    status: 'not_configured',
    napcatDir,
    configFiles,
    httpUrl: detectedUrl,
    accessToken: detectedToken,
    message: `检测到 NapCat 安装于 ${napcatDir}，尚未开启 HTTP 3000 服务`
  }
}

/**
 * 获取 NapCat 的自动推荐配置（供一键自动配置按钮调用）
 */
export async function getNapCatAutoConfig(options = {}) {
  const customPath = options.customPath || ''
  const napcatDir = locateNapCatInstallation(customPath)
  let port = 3000
  let token = ''

  if (napcatDir) {
    const configFiles = getNapCatConfigFiles(napcatDir)
    for (const file of configFiles) {
      const json = readJsonSafe(file)
      const servers = json?.network?.httpServers
      if (Array.isArray(servers) && servers.length > 0) {
        const active = servers.find(s => s.enable !== false) || servers[0]
        if (active) {
          if (active.port) port = Number(active.port) || 3000
          if (typeof active.token === 'string') token = active.token.trim()
          break
        }
      }
    }
  }

  const httpUrl = `http://127.0.0.1:${port}`
  const probe = await probeOneBotHttp({ url: httpUrl, token })
  return {
    ok: true,
    httpUrl,
    accessToken: token,
    running: probe.ok,
    versionInfo: probe.versionInfo || null,
    napcatDir: napcatDir || null
  }
}

/**
 * 一键为 NapCat 开启 OneBot 11 HTTP 服务
 */
export async function enableNapCatHttpServer(options = {}) {
  const customPath = options.customPath || ''
  const port = Number(options.port) || 3000
  const token = options.token ? String(options.token).trim() : ''

  const napcatDir = locateNapCatInstallation(customPath)
  if (!napcatDir) {
    return { ok: false, error: '未定位到 NapCat 安装目录，请确认安装或手动指定路径' }
  }

  let configFiles = getNapCatConfigFiles(napcatDir)
  if (configFiles.length === 0) {
    // 兜底新建 onebot11.json
    const defaultCfgPath = join(napcatDir, 'config', 'onebot11.json')
    configFiles = [defaultCfgPath]
  }

  const updatedFiles = []
  for (const file of configFiles) {
    try {
      let json = readJsonSafe(file) || {}
      if (!json.network || typeof json.network !== 'object') {
        json.network = {}
      }
      if (!Array.isArray(json.network.httpServers)) {
        json.network.httpServers = []
      }

      // 安全备份：仅在尚未备份过时创建 .bak
      const bakFile = `${file}.bak`
      if (!existsSync(bakFile) && existsSync(file)) {
        try { copyFileSync(file, bakFile) } catch {}
      }

      // 查找或添加 port 对应的项
      const existing = json.network.httpServers.find(s => Number(s.port) === port)
      if (existing) {
        existing.enable = true
        if (token) existing.token = token
      } else {
        json.network.httpServers.push({
          name: 'http-server',
          enable: true,
          port,
          host: '127.0.0.1',
          enableCors: true,
          enableWebsocket: false,
          messagePostFormat: 'array',
          token,
          debug: false
        })
      }

      writeFileSync(file, JSON.stringify(json, null, 2), 'utf8')
      updatedFiles.push(file)
    } catch (err) {
      return { ok: false, error: `写入配置文件 ${file} 失败: ${err?.message || err}` }
    }
  }

  return {
    ok: true,
    napcatDir,
    updatedFiles,
    port,
    httpUrl: `http://127.0.0.1:${port}`,
    accessToken: token,
    message: 'OneBot 11 HTTP 服务配置已成功写入！请重启 NapCat 客户端以立即生效。'
  }
}

