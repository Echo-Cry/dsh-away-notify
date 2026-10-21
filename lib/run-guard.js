// 同一时刻只允许一轮「采集→写文案→投递」在跑。
// 定时轮询和设置页的「测试运行」共用这个闸门：两边同时跑会双倍 token、
// 同一条消息推两遍、runs.jsonl 写成交错的记录。
let busySince = 0

export function isRunBusy() {
  return busySince > 0
}

export function busyForMs(now = Date.now()) {
  return busySince > 0 ? now - busySince : 0
}

/** 抢到闸门返回 true；已经在跑返回 false。 */
export function tryEnterRun() {
  if (busySince > 0) return false
  busySince = Date.now()
  return true
}

export function exitRun() {
  busySince = 0
}
