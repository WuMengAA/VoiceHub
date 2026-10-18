import { defineEventHandler, readBody } from 'h3'
import { client, db } from '~/drizzle/db'
import { songs } from '~/drizzle/schema'
import { inArray } from 'drizzle-orm'
import { createApiError } from '~~/server/utils/apiError'
import { SERVER_ERROR_CODES } from '~~/server/config/constants'
import { requireBroadcastAuthority } from '~~/server/utils/broadcast-authority'
import { getBeijingTimeISOString } from '~/utils/timeUtils'
import {
  clearBroadcastQueue,
  getBroadcastQueue,
  getNextQueueItem,
  setBroadcastQueue,
  type BroadcastQueueItem
} from '~~/server/utils/broadcast-state'

// 播放单一次最多排多少首。再长就不是「一次广播」而是把整个学期塞进来了
const MAX_QUEUE_LENGTH = 100

/**
 * 设置播放单（连播队列）。
 *
 * 前端只提交 songId 列表：曲目的封面、时长、排期落点都由服务端补全，
 * 客户端不需要为了排单额外拉一遍歌单数据，也避免了被伪造的元数据写进广播状态。
 *
 * 行为：
 * - `{ songIds: [...] }`：整体替换播放单（保持提交顺序）；
 * - `{ action: 'clear' }` 或空数组：清空播放单。
 */
export default defineEventHandler(async (event) => {
  // 排播放单属于播控行为，走与上报一致的门禁
  const authority = await requireBroadcastAuthority(event)

  const body = await readBody(event).catch(() => null)
  if (!body || typeof body !== 'object') {
    throw createApiError(400, SERVER_ERROR_CODES.COMMON_INVALID_PARAMS, '无效的请求数据')
  }

  if (body.action === 'clear') {
    clearBroadcastQueue()
    return { success: true, queue: [], currentIndex: -1, nextUp: null, autoAdvance: authority.autoAdvance }
  }

  if (!Array.isArray(body.songIds)) {
    throw createApiError(400, SERVER_ERROR_CODES.COMMON_INVALID_PARAMS, 'songIds 必须是歌曲 ID 数组')
  }

  const songIds = [...new Set(body.songIds.map((id: unknown) => Number(id)))]
    .filter((id) => Number.isInteger(id) && id > 0)
    .slice(0, MAX_QUEUE_LENGTH)

  if (songIds.length === 0) {
    clearBroadcastQueue()
    return { success: true, queue: [], currentIndex: -1, nextUp: null, autoAdvance: authority.autoAdvance }
  }

  const songRows = await db
    .select({
      id: songs.id,
      title: songs.title,
      artist: songs.artist,
      cover: songs.cover,
      musicPlatform: songs.musicPlatform,
      musicId: songs.musicId,
      durationSeconds: songs.durationSeconds
    })
    .from(songs)
    .where(inArray(songs.id, songIds))

  // 当日排期落点：同一首歌一天可能排多次，取序号最小的那条作为代表
  const playDate = getBeijingTimeISOString().slice(0, 10)
  const bindingMap = new Map<number, { scheduleId: number; sequence: number }>()
  try {
    const scheduleRows = await client.unsafe(
      `SELECT id, "songId", sequence
       FROM "Schedule"
       WHERE "isDraft" = false
         AND "songId" = ANY($1::int[])
         AND to_char("playDate", 'YYYY-MM-DD') = $2
       ORDER BY sequence`,
      [songIds, playDate]
    )
    for (const row of scheduleRows) {
      const songId = Number(row.songId)
      if (!bindingMap.has(songId)) {
        bindingMap.set(songId, { scheduleId: Number(row.id), sequence: Number(row.sequence || 1) })
      }
    }
  } catch (error) {
    // 排期查不到不影响排单，只是「正在播放」标不到具体那一条上
    console.error('查询播放单排期绑定失败:', error)
  }

  const songMap = new Map(songRows.map((row) => [row.id, row]))
  const items: BroadcastQueueItem[] = []
  for (const songId of songIds) {
    const song = songMap.get(songId)
    if (!song) continue
    const binding = bindingMap.get(songId)
    items.push({
      songId,
      title: song.title,
      artist: song.artist,
      cover: song.cover ?? null,
      musicPlatform: song.musicPlatform ?? null,
      musicId: song.musicId ?? null,
      duration: Number(song.durationSeconds) || 0,
      scheduleId: binding?.scheduleId ?? null,
      playDate,
      sequence: binding?.sequence ?? null
    })
  }

  const queue = setBroadcastQueue(items)
  const { currentIndex } = getBroadcastQueue()

  return {
    success: true,
    queue,
    currentIndex,
    nextUp: getNextQueueItem(),
    autoAdvance: authority.autoAdvance
  }
})
