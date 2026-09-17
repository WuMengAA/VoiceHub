import { defineEventHandler, readBody } from 'h3'
import { client } from '~/drizzle/db'
import { createApiError } from '~~/server/utils/apiError'
import { SERVER_ERROR_CODES } from '~~/server/config/constants'
import { requireSongAdmin } from '~~/server/utils/requireSongAdmin'
import { getBeijingTimeISOString } from '~/utils/timeUtils'
import { getServerTimestamp } from '~~/server/utils/serverTime'
import { applyBroadcastReport, stopBroadcast } from '~~/server/utils/broadcast-state'
import { broadcastBroadcastState } from './websocket'

// 歌曲 → 当日排期的绑定结果缓存，避免每次进度上报都查库；排期可能被临时调整，因此限时生效
const BINDING_CACHE_TTL_MS = 60_000
const scheduleBindingCache = new Map<
  string,
  { at: number; value: { scheduleId: number; sequence: number } | null }
>()

/**
 * 查询歌曲在指定日期已发布排期中的落点。
 * 学生端与教室大屏靠它把「正在播放」标注到当日固定排期的具体一条上。
 */
async function resolveScheduleBinding(songId: number, playDate: string) {
  const cacheKey = `${songId}:${playDate}`
  const cached = scheduleBindingCache.get(cacheKey)
  if (cached && getServerTimestamp() - cached.at < BINDING_CACHE_TTL_MS) {
    return cached.value
  }

  let binding: { scheduleId: number; sequence: number } | null = null
  try {
    const rows = await client.unsafe(
      `SELECT id, sequence
       FROM "Schedule"
       WHERE "songId" = $1
         AND "isDraft" = false
         AND to_char("playDate", 'YYYY-MM-DD') = $2
       ORDER BY sequence
       LIMIT 1`,
      [songId, playDate]
    )
    if (rows.length > 0) {
      binding = { scheduleId: Number(rows[0].id), sequence: Number(rows[0].sequence || 1) }
    }
  } catch (error) {
    console.error('查询广播排期绑定失败:', error)
  }

  if (scheduleBindingCache.size > 500) {
    scheduleBindingCache.clear()
  }
  scheduleBindingCache.set(cacheKey, { at: getServerTimestamp(), value: binding })
  return binding
}

export default defineEventHandler(async (event) => {
  // 只有歌曲管理员及以上权限才能对外播报「正在播放」，避免学生端伪造广播
  requireSongAdmin(event)
  const user = event.context.user

  const body = await readBody(event).catch(() => null)
  if (!body || typeof body !== 'object') {
    throw createApiError(400, SERVER_ERROR_CODES.COMMON_INVALID_PARAMS, '无效的请求数据')
  }

  if (body.action === 'stop') {
    stopBroadcast()
    broadcastBroadcastState(null)
    return { success: true, broadcast: null, serverTime: getServerTimestamp() }
  }

  const songId = Number(body.songId)
  if (!Number.isInteger(songId) || songId <= 0) {
    throw createApiError(400, SERVER_ERROR_CODES.COMMON_INVALID_PARAMS, '缺少有效的歌曲 ID')
  }

  const playDate = getBeijingTimeISOString().slice(0, 10)
  const binding = await resolveScheduleBinding(songId, playDate)

  const snapshot = applyBroadcastReport({
    songId,
    title: body.title,
    artist: body.artist,
    cover: body.cover,
    musicPlatform: body.musicPlatform,
    musicId: body.musicId,
    duration: body.duration,
    position: body.position,
    isPlaying: body.isPlaying !== false,
    scheduleId: binding?.scheduleId ?? null,
    playDate,
    sequence: binding?.sequence ?? null,
    publisherId: user?.id ?? null,
    publisherName: user?.name ?? null
  })

  broadcastBroadcastState(snapshot)

  return { success: true, broadcast: snapshot, serverTime: getServerTimestamp() }
})
