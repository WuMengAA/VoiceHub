import { createError, defineEventHandler, getQuery, setHeader } from 'h3'
import { db } from '~/drizzle/db'
import { broadcastPlayLogs } from '~/drizzle/schema'
import { and, count, desc, eq, gte, lt, type SQL } from 'drizzle-orm'

/** 播出日志的导出上限：一次导出够查一个月的问题就行，再多交给分页接口 */
const MAX_EXPORT_ROWS = 5000

const REASON_LABELS: Record<string, string> = {
  STOPPED: '主动结束',
  SWITCHED: '切换下一首',
  AUTO_ADVANCED: '自动连播',
  EXPIRED: '播控端失联',
  DISABLED: '播控已关闭',
  TAKEOVER: '播控权接管'
}

const escapeCsvField = (value: unknown): string => {
  const text = value === null || value === undefined ? '' : String(value)
  return `"${text.replace(/"/g, '""')}"`
}

const toLocalText = (value: unknown): string => {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', { hour12: false })
}

/**
 * 播出日志查询与导出（管理员与超级管理员）。
 *
 * - 默认按开播时间倒序分页返回；
 * - `format=csv` 直接导出 CSV（带 BOM，Excel 打开不乱码）；
 * - 可按 dateFrom / dateTo / broadcasterId / songId 过滤。
 */
export default defineEventHandler(async (event) => {
  const user = event.context.user
  if (!user || !['ADMIN', 'SUPER_ADMIN'].includes(user.role)) {
    throw createError({ statusCode: 403, message: '需要管理员权限' })
  }

  const query = getQuery(event)
  const page = Math.max(1, parseInt(String(query.page)) || 1)
  const limit = Math.min(100, Math.max(1, parseInt(String(query.limit)) || 20))
  const format = query.format === 'csv' ? 'csv' : 'json'
  const broadcasterId = parseInt(String(query.broadcasterId ?? '')) || null
  const songId = parseInt(String(query.songId ?? '')) || null

  const conditions: (SQL | undefined)[] = []
  if (broadcasterId) {
    conditions.push(eq(broadcastPlayLogs.broadcasterId, broadcasterId))
  }
  if (songId) {
    conditions.push(eq(broadcastPlayLogs.songId, songId))
  }
  if (query.dateFrom) {
    const from = new Date(String(query.dateFrom))
    if (!Number.isNaN(from.getTime())) {
      conditions.push(gte(broadcastPlayLogs.startedAt, from))
    }
  }
  if (query.dateTo) {
    const to = new Date(String(query.dateTo))
    if (!Number.isNaN(to.getTime())) {
      conditions.push(lt(broadcastPlayLogs.startedAt, to))
    }
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined

  try {
    const [totalRow] = await db
      .select({ total: count() })
      .from(broadcastPlayLogs)
      .where(where)
    const total = Number(totalRow?.total || 0)

    const rows = await db
      .select()
      .from(broadcastPlayLogs)
      .where(where)
      .orderBy(desc(broadcastPlayLogs.startedAt))
      .limit(format === 'csv' ? MAX_EXPORT_ROWS : limit)
      .offset(format === 'csv' ? 0 : (page - 1) * limit)

    const items = rows.map((row) => ({
      id: row.id,
      songId: row.songId,
      title: row.songTitle,
      artist: row.songArtist,
      cover: row.cover,
      scheduleId: row.scheduleId,
      sequence: row.sequence,
      playDate: row.playDate,
      broadcasterId: row.broadcasterId,
      broadcasterName: row.broadcasterName,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      playedSeconds: row.playedSeconds,
      listenerPeak: row.listenerPeak,
      endReason: row.endReason,
      endReasonLabel: row.endReason ? REASON_LABELS[row.endReason] || row.endReason : null
    }))

    if (format === 'csv') {
      const header = [
        '日志ID',
        '歌曲ID',
        '歌曲',
        '歌手',
        '排期ID',
        '排期序号',
        '播出日',
        '播控人ID',
        '播控人',
        '开播时间',
        '结束时间',
        '播出秒数',
        '收听峰值',
        '结束原因'
      ]
      const lines = [
        header.map(escapeCsvField).join(','),
        ...items.map((row) =>
          [
            row.id,
            row.songId,
            row.title,
            row.artist,
            row.scheduleId,
            row.sequence,
            row.playDate,
            row.broadcasterId,
            row.broadcasterName,
            toLocalText(row.startedAt),
            toLocalText(row.endedAt),
            row.playedSeconds,
            row.listenerPeak,
            row.endReasonLabel || row.endReason
          ]
            .map(escapeCsvField)
            .join(',')
        )
      ]
      setHeader(event, 'Content-Type', 'text/csv; charset=utf-8')
      setHeader(
        event,
        'Content-Disposition',
        `attachment; filename="broadcast-play-logs-${Date.now()}.csv"`
      )
      // UTF-8 BOM：Excel 直接双击打开时不会把中文列读成乱码
      return `\uFEFF${lines.join('\r\n')}`
    }

    return {
      success: true,
      logs: items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit))
      }
    }
  } catch (error: any) {
    console.error('[admin] 查询播出日志失败:', error)
    throw createError({ statusCode: 500, message: '查询播出日志失败' })
  }
})
