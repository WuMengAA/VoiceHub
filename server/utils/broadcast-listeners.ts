/**
 * 校园广播「在线收听人数」统计
 *
 * 只是个带过期时间的登记表，不落库：人数是瞬时状态，进程重启后从零开始统计，
 * 顶多让数字抖一下，不值得为它写一张表。
 *
 * 登记来源有两个，二者共用同一个 key（登录用户用 userId，匿名用 SSE 连接 ID）：
 * - SSE 连接建立/关闭（websocket.ts）：连接期间自动算在听，断开立刻注销；
 * - 学生端心跳（broadcast/listeners）：页面停留者定期续期。
 *
 * 防刷：单条 key 多次上报只是续期，不会让数字变大；真正的上限由 SSE 连接数与
 * 心跳接口的 IP 限流共同约束，这里不做业务逻辑判断。
 */

// 心跳过期时间：超过这个时间没续期就认为人已经走了
const LISTENER_TTL_MS = 45_000
// 登记表大小上限，防止异常流量把内存撑爆
const MAX_LISTENERS = 5000
// 清理周期：不必每次读都全表扫描
const SWEEP_INTERVAL_MS = 30_000

const listeners = new Map<string, number>()
let lastSweepAt = 0

/**
 * 登记/续期一个收听者。
 * @param key 稳定标识：登录用户用 `user:<id>`，匿名用 `anon:<connectionId>`
 */
export function touchListener(key: string, now: number = Date.now()): void {
  if (!key) return
  if (listeners.size >= MAX_LISTENERS && !listeners.has(key)) {
    // 满了就先清一轮过期项，仍满则丢弃新登记（宁可少算不多占）
    sweepListeners(now)
    if (listeners.size >= MAX_LISTENERS) return
  }
  listeners.set(key, now)
}

/** 注销一个收听者（SSE 断开时调用） */
export function removeListener(key: string): void {
  if (!key) return
  listeners.delete(key)
}

/** 清理过期收听者 */
export function sweepListeners(now: number = Date.now()): void {
  listeners.forEach((lastSeen, key) => {
    if (now - lastSeen > LISTENER_TTL_MS) {
      listeners.delete(key)
    }
  })
  lastSweepAt = now
}

/** 当前在线收听人数 */
export function countActiveListeners(now: number = Date.now()): number {
  if (now - lastSweepAt >= SWEEP_INTERVAL_MS) {
    sweepListeners(now)
  }
  return listeners.size
}

/** 清空登记表（测试与停用统计时使用） */
export function resetListeners(): void {
  listeners.clear()
  lastSweepAt = 0
}
