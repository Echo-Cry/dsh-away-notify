import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'

export function getDataDir() {
  const base = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dir = join(base, 'away-notify-data')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

export function atomicWriteText(filePath, text) {
  const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(16).slice(2)}`
  writeFileSync(tmpPath, text, 'utf-8')
  renameSync(tmpPath, filePath)
}

export function atomicWriteJson(filePath, data) {
  atomicWriteText(filePath, JSON.stringify(data, null, 2))
}

export function readJsonSafe(filePath, fallback = null) {
  let raw = null
  try {
    if (!existsSync(filePath)) return fallback
    raw = readFileSync(filePath, 'utf-8')
  } catch {
    return fallback
  }
  try {
    return JSON.parse(raw)
  } catch {
    // 文件存在但解析不了：先留一份 .bad-<时间>，否则下一次 saveConfig 会把它覆盖掉，
    // 用户的会话/兴趣/自定义源就静默没了。
    try {
      renameSync(filePath, `${filePath}.bad-${Date.now()}`)
    } catch {}
    return fallback
  }
}

export function acquireLock() {
  const lockFile = join(getDataDir(), 'lock')
  if (existsSync(lockFile)) {
    let info = null
    try {
      info = JSON.parse(readFileSync(lockFile, 'utf-8'))
    } catch {
      // 锁文件坏了：当残留锁覆盖
      info = null
    }
    const pid = info?.pid
    if (typeof pid === 'number' && pid > 0) {
      try {
        process.kill(pid, 0)
        return { acquired: false, existingPid: pid }
      } catch (e) {
        // 只有「进程确实不存在」才算残留锁。EPERM 说明进程活着（只是没权限发信号），
        // 当成残留锁抢过来会让两个实例同时轮询、重复推送。
        if (e?.code !== 'ESRCH') return { acquired: false, existingPid: pid }
      }
    }
  }

  try {
    atomicWriteJson(lockFile, { pid: process.pid, at: new Date().toISOString(), beat: Date.now() })
    return { acquired: true }
  } catch (e) {
    return { acquired: false, error: e.message }
  }
}

/** 心跳：让别的实例看得出「这个锁还是活的」 */
export function touchLock() {
  const lockFile = join(getDataDir(), 'lock')
  try {
    if (!existsSync(lockFile)) return
    const info = JSON.parse(readFileSync(lockFile, 'utf-8'))
    if (info?.pid !== process.pid) return
    atomicWriteJson(lockFile, { ...info, beat: Date.now() })
  } catch {}
}

export function releaseLock() {
  const lockFile = join(getDataDir(), 'lock')
  try {
    if (existsSync(lockFile)) {
      const info = JSON.parse(readFileSync(lockFile, 'utf-8'))
      if (info?.pid === process.pid) {
        unlinkSync(lockFile)
      }
    }
  } catch {}
}
