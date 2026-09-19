import { defineEventHandler } from 'h3'
import { getServerTimestamp } from '~~/server/utils/serverTime'
import { getBroadcastSnapshot, syncBroadcastSession } from '~~/server/utils/broadcast-state'
import { resolveBroadcastAuthority } from '~~/server/utils/broadcast-authority'

/**
 * 读取当前校园广播「正在播放」状态。
 *
 * 公开接口：学生端与教室大屏无需登录即可读取，用于首屏对齐 SSE 之外的兜底轮询；
 * broadcast 为 null 表示当前没有广播（或播控已被管理员关闭）。
 * position 已按服务器时间外推到当前时刻，客户端只需再叠加「本机与服务器的时间差」即可持续推演进度。
 *
 * 快照里额外带：当前收听人数 listenerCount、播放单的下一首 nextUp、队列剩余 queueRemaining。
 * 这里顺带做一次连播自检——轮询是读接口里唯一稳定的心跳，适合同步自动切歌。
 */
export default defineEventHandler(async () => {
  const authority = await resolveBroadcastAuthority()

  if (!authority.enabled) {
    return {
      broadcast: null,
      serverTime: getServerTimestamp()
    }
  }

  const session = syncBroadcastSession({ autoAdvance: authority.autoAdvance })
  return {
    broadcast: session.snapshot ?? getBroadcastSnapshot(),
    serverTime: getServerTimestamp()
  }
})
