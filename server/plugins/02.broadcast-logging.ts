/**
 * 服务启动时把播出日志的落库回调挂到广播状态机上。
 *
 * 状态机本身不碰数据库（便于单测），改为抛出播出事件；这里注册 sink，
 * 让任何一条路径产生的播出事件——上报、结束广播、过期结算、连播切歌——都能落到
 * BroadcastPlayLog。注册前堆积的事件在这里补写一次。
 */
import { consumePlayLogEvents, setPlayLogSink } from '~~/server/utils/broadcast-state'
import { handlePlayLogEvent } from '~~/server/utils/broadcast-logs'

export default defineNitroPlugin(() => {
  setPlayLogSink(handlePlayLogEvent)
  const pending = consumePlayLogEvents()
  pending.forEach(handlePlayLogEvent)
})
