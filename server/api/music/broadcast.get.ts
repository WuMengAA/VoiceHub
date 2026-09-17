import { defineEventHandler } from 'h3'
import { getServerTimestamp } from '~~/server/utils/serverTime'
import { getBroadcastSnapshot } from '~~/server/utils/broadcast-state'

/**
 * 读取当前校园广播「正在播放」状态。
 *
 * 公开接口：学生端与教室大屏无需登录即可读取，用于首屏对齐 SSE 之外的兜底轮询；
 * broadcast 为 null 表示当前没有广播。position 已按服务器时间外推到当前时刻，
 * 客户端只需再叠加「本机与服务器的时间差」即可持续推演进度。
 */
export default defineEventHandler(() => {
  return {
    broadcast: getBroadcastSnapshot(),
    serverTime: getServerTimestamp()
  }
})
