const PS_LOOP = `
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class IdleProbe {
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  public static long IdleSeconds() {
    LASTINPUTINFO li = new LASTINPUTINFO();
    li.cbSize = (uint)Marshal.SizeOf(li);
    if (!GetLastInputInfo(ref li)) return -1;
    // 用无符号差值：TickCount 每 ~24.8 天回绕一次，bit-and 掩码会在回绕后算出 0（假的「刚活动」）
    uint now = unchecked((uint)Environment.TickCount);
    return unchecked(now - li.dwTime) / 1000;
  }
}
'@
while ($true) {
  try {
    [Console]::Out.WriteLine([IdleProbe]::IdleSeconds())
    [Console]::Out.Flush()
  } catch {}
  Start-Sleep -Seconds 1
}
`

export function createIdleProbe(ctx, logger = null) {
  let activeHandle = null
  let stopped = false
  let idleSeconds = 0
  let lastUpdateAt = 0
  let probeDown = false
  let failCount = 0
  let restartTimer = null
  let buffer = ''
  let stdoutOffset = 0

  const BACKOFF_MS = [2000, 8000, 30000]
  const STALE_MS = 10_000 // 10 秒没有新读数就认为探测不新鲜（脚本每秒输出一次）

  function scheduleRestart() {
    if (stopped) return
    failCount++
    if (failCount >= 5) {
      probeDown = true
      logger?.warn?.(`[idle-probe] Probe down after 5 consecutive failures`)
    }
    const delay = BACKOFF_MS[Math.min(failCount - 1, BACKOFF_MS.length - 1)]
    clearTimeout(restartTimer)
    restartTimer = setTimeout(() => {
      if (!stopped) spawnProbe()
    }, delay)
  }

  function spawnProbe() {
    if (stopped) return
    const subprocess = ctx.get('subprocess')
    if (!subprocess?.spawn) {
      // 启动竞态很常见（插件比 subprocess 服务先起来）：只置 probeDown 会永久读不到闲置，
      // 这里必须排一次重启，等服务就绪后自然恢复。
      probeDown = true
      logger?.warn?.('[idle-probe] subprocess service unavailable, retrying')
      scheduleRestart()
      return
    }

    try {
      buffer = ''
      stdoutOffset = 0
      const spawnedAt = Date.now()
      let restarting = false
      const handle = subprocess.spawn({
        argv: ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', PS_LOOP],
        cwd: process.cwd(),
        stdio: {
          stdin: { data: '' },
          stdout: { maxBytes: 8192 },
          stderr: { maxBytes: 8192 }
        },
        // 长驻进程：给足正的宽限期。宿主对 0 的处理是「立刻可回收」，
        // 会让探测每次秒死 → 退避重启 → 连续失败被判定为 probeDown。
        graceMs: 8000
      })
      activeHandle = handle

      // Polling output from collected stdout stream buffer
      const checkInterval = setInterval(() => {
        if (stopped || activeHandle !== handle) {
          clearInterval(checkInterval)
          return
        }

        try {
          // 宿主 collected.stdout 是 SubprocessOutputReader：readFrom(offset) 非消费式增量读
          const reader = handle.collected?.stdout
          if (reader && typeof reader.readFrom === 'function') {
            const read = reader.readFrom(stdoutOffset)
            if (typeof read?.nextOffset === 'number') stdoutOffset = read.nextOffset
            if (read?.text) buffer += read.text
          } else if (typeof reader === 'string') {
            buffer = reader
          } else if (Array.isArray(reader)) {
            buffer = reader.map(c => typeof c === 'string' ? c : Buffer.isBuffer(c) ? c.toString('utf-8') : '').join('')
          } else if (Buffer.isBuffer(reader)) {
            buffer = reader.toString('utf-8')
          }

          if (buffer.length > 8192) buffer = buffer.slice(-8192)

          if (buffer) {
            const lines = buffer.trim().split(/\r?\n/)
            for (let i = lines.length - 1; i >= 0; i--) {
              const val = parseInt(lines[i].trim(), 10)
              if (!isNaN(val) && val >= 0) {
                idleSeconds = val
                lastUpdateAt = Date.now()
                failCount = 0
                probeDown = false
                break
              }
            }
          }
        } catch (e) {
          // ignore parsing error
        }

        // 失鲜检测：脚本每秒输出一行，10 秒没新数据就说明探测进程卡死了
        if (lastUpdateAt && Date.now() - lastUpdateAt > STALE_MS) {
          if (!probeDown) {
            probeDown = true
            logger?.warn?.(`[idle-probe] Probe stale for ${Math.round((Date.now() - lastUpdateAt) / 1000)}s`)
          }
          // 卡死不重启的话 idleSeconds 会永远冻在旧值：idle-only 永久跳过、回座检测也永不触发
          if (!restarting) {
            restarting = true
            logger?.warn?.('[idle-probe] Restarting stale probe process')
            clearInterval(checkInterval)
            try {
              if (typeof handle.terminate === 'function') handle.terminate()
            } catch {}
            if (activeHandle === handle) activeHandle = null
            scheduleRestart()
          }
        } else if (!lastUpdateAt && Date.now() - spawnedAt > 15_000 && !restarting) {
          // 15 秒还没读出任何数字 → 当作「读不到」，按退避重启
          restarting = true
          logger?.warn?.('[idle-probe] No reading within 15s, restarting probe')
          clearInterval(checkInterval)
          try {
            if (typeof handle.terminate === 'function') handle.terminate()
          } catch {}
          if (activeHandle === handle) activeHandle = null
          scheduleRestart()
        }
      }, 1000)

      handle.done?.then((res) => {
        clearInterval(checkInterval)
        if (activeHandle === handle) {
          activeHandle = null
          if (!stopped) {
            scheduleRestart()
          }
        }
      }).catch(() => {
        clearInterval(checkInterval)
        if (activeHandle === handle) {
          activeHandle = null
          if (!stopped) {
            scheduleRestart()
          }
        }
      })

    } catch (e) {
      logger?.error?.('[idle-probe] spawn error:', e)
      scheduleRestart()
    }
  }

  function start() {
    stopped = false
    failCount = 0
    probeDown = false
    spawnProbe()
  }

  function stop() {
    stopped = true
    clearTimeout(restartTimer)
    // 宿主 SubprocessHandle 的终止入口是 terminate()；保留 kill() 兜底
    if (typeof activeHandle?.terminate === 'function') {
      try {
        activeHandle.terminate()
      } catch {}
    } else if (typeof activeHandle?.kill === 'function') {
      try {
        activeHandle.kill()
      } catch {}
    }
    activeHandle = null
  }

  function getIdleSeconds() {
    return idleSeconds
  }

  function isProbeDown() {
    return probeDown
  }

  function getStatus() {
    return {
      idleSeconds,
      lastUpdateAt,
      probeDown,
      active: Boolean(activeHandle && !stopped)
    }
  }

  return {
    start,
    stop,
    getIdleSeconds,
    isProbeDown,
    getStatus
  }
}
