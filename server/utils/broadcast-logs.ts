/**
 * 播出日志落库
 *
 * broadcast-state 只负责把「这段播完了」抛成事件，真正写库在这里——
 * 分开是为了让状态机保持无 DB 依赖，能被纯 Node 单测覆盖。
 *
 * 一条播出对应表里一行：start 事件插入（endedAt 为空），end 事件回填结束信息。
 * 若进程重启丢失了内存里的对应关系，end 事件会按「同歌曲 + 同开播时间 + 未结束」回捞那一行，
 * 实在找不到就直接补一整行，宁可有重复也不丢一次播出。
 */
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '~/drizzle/db'
import { broadcastPlayLogs } from '~/drizzle/schema'
import type { BroadcastPlayLogEvent } from './broadcast-state'

const toDate = (timestamp: number): Date => new Date(Math.round(timestamp))

/** 找到尚未结束的对应日志行 */
async function findOpenLog(songId: number, startedAt: number) {
  const rows = await db
    .select({ id: broadcastPlayLogs.id })
    .from(broadcastPlayLogs)
    .where(
      and(
        eq(broadcastPlayLogs.songId, songId),
        eq(broadcastPlayLogs.startedAt, toDate(startedAt)),
        isNull(broadcastPlayLogs.endedAt)
      )
    )
    .orderBy(desc(broadcastPlayLogs.id))
    .limit(1)
  return rows[0]?.id ?? null
}

export async function persistPlayLogEvent(event: BroadcastPlayLogEvent): Promise<void> {
  if (event.type === 'start') {
    await db.insert(broadcastPlayLogs).values({
      songId: event.songId,
      songTitle: event.title || null,
      songArtist: event.artist || null,
      cover: event.cover,
      scheduleId: event.scheduleId,
      sequence: event.sequence,
      playDate: event.playDate,
      broadcasterId: event.publisherId,
      broadcasterName: event.publisherName,
      startedAt: toDate(event.startedAt)
    })
    return
  }

  const endedAt = event.endedAt ?? Date.now()
  const patch = {
    endedAt: toDate(endedAt),
    playedSeconds: event.playedSeconds ?? 0,
    endReason: event.endReason ?? 'STOPPED',
    listenerPeak: event.listenerPeak ?? 0,
    // 结束时的歌曲信息以实际播出为准（避免开播时元数据还没上报完）
    songTitle: event.title || null,
    songArtist: event.artist || null,
    cover: event.cover,
    scheduleId: event.scheduleId,
    sequence: event.sequence,
    playDate: event.playDate,
    updatedAt: new Date()
  }

  const openId = await findOpenLog(event.songId, event.startedAt)
  if (openId !== null) {
    await db.update(broadcastPlayLogs).set(patch).where(eq(broadcastPlayLogs.id, openId))
    return
  }

  // start 事件没落库（进程重启等）时补一整行，保证播出记录不丢
  await db.insert(broadcastPlayLogs).values({
    songId: event.songId,
    songTitle: event.title || null,
    songArtist: event.artist || null,
    cover: event.cover,
    scheduleId: event.scheduleId,
    sequence: event.sequence,
    playDate: event.playDate,
    broadcasterId: event.publisherId,
    broadcasterName: event.publisherName,
    startedAt: toDate(event.startedAt),
    ...patch
  })
}

/** 作为 broadcast-state 的 sink：写库失败只记日志，绝不影响广播本身 */
export function handlePlayLogEvent(event: BroadcastPlayLogEvent): void {
  void persistPlayLogEvent(event).catch((error) => {
    console.error('[broadcast] 写入播出日志失败:', error)
  })
}
