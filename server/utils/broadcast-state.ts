/**
 * 校园广播「正在播放」权威状态
 *
 * 播控端（歌曲管理员及以上）在播放、暂停、切歌、拖动进度时向服务端上报；
 * 服务端只保存一份权威状态，并向所有 SSE 订阅者与开放接口下发，
 * 学生端据此同步当前歌曲与播放进度。
 *
 * 状态仅保存在进程内存中：广播是实时行为，服务重启后由播控端下一次上报重建，
 * 因此不落库、不引入数据库迁移。
 */
import { getServerTimestamp } from './serverTime.ts'

// 播放中无上报的容错窗口，超过即认为播控端已离线
const PLAYING_STALE_MS = 90_000
// 暂停状态保留时长，超时后失效，避免学生端长期停留在「已暂停」
const PAUSED_STALE_MS = 30 * 60_000
// 进度超出总时长的容错秒数，超过即认定本曲已播完
const END_TOLERANCE_SECONDS = 5

/** 播控端上报的字段 */
export interface BroadcastReport {
  songId: number
  title?: string | null
  artist?: string | null
  cover?: string | null
  musicPlatform?: string | null
  musicId?: string | null
  duration?: number | null
  position?: number | null
  isPlaying?: boolean | null
  scheduleId?: number | null
  playDate?: string | null
  sequence?: number | null
  publisherId?: number | null
  publisherName?: string | null
}

/** 对外下发的广播状态快照（position 已按服务器时间外推到当前时刻） */
export interface BroadcastSnapshot {
  songId: number
  scheduleId: number | null
  playDate: string | null
  sequence: number | null
  title: string
  artist: string
  cover: string | null
  musicPlatform: string | null
  musicId: string | null
  duration: number
  position: number
  isPlaying: boolean
  publisherName: string | null
  /** 播控端最后一次上报的服务器时间戳 */
  updatedAt: number
}

interface InternalState extends Omit<BroadcastSnapshot, 'position'> {
  /** 上报时刻的进度，实时进度由此按服务器时间外推 */
  anchorPosition: number
  /** 上报时刻的服务器时间戳 */
  anchorAt: number
}

let state: InternalState | null = null

const toPositiveNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

const toTrimmedText = (value: unknown, maxLength: number): string => {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maxLength)
}

const toNullableText = (value: unknown, maxLength: number): string | null => {
  const text = toTrimmedText(value, maxLength)
  return text ? text : null
}

const toNullableId = (value: unknown): number | null => {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

/** 判断状态是否已过期（播控端离线或曲目已播完） */
const isExpired = (current: InternalState, now: number): boolean => {
  const idleMs = now - current.updatedAt
  if (current.isPlaying) {
    if (idleMs > PLAYING_STALE_MS) return true
    // 播控端中途离线时，按外推进度判定本曲是否已播完，无需等满空窗
    if (current.duration > 0) {
      const consumed = current.anchorPosition + (now - current.anchorAt) / 1000
      if (consumed > current.duration + END_TOLERANCE_SECONDS) return true
    }
    return false
  }
  return idleMs > PAUSED_STALE_MS
}

/**
 * 获取当前广播状态快照。
 * 无广播或状态已过期时返回 null，调用方应据此隐藏「正在播放」相关界面。
 * @param now 参考时间戳，默认取服务器当前时间（测试可注入以便校验过期判定）
 */
export function getBroadcastSnapshot(now: number = getServerTimestamp()): BroadcastSnapshot | null {
  if (!state) return null

  if (isExpired(state, now)) {
    state = null
    return null
  }

  let position = state.anchorPosition
  if (state.isPlaying) {
    position = state.anchorPosition + (now - state.anchorAt) / 1000
  }
  if (state.duration > 0) {
    position = Math.min(position, state.duration)
  }

  return {
    songId: state.songId,
    scheduleId: state.scheduleId,
    playDate: state.playDate,
    sequence: state.sequence,
    title: state.title,
    artist: state.artist,
    cover: state.cover,
    musicPlatform: state.musicPlatform,
    musicId: state.musicId,
    duration: state.duration,
    position: Math.max(0, Number(position.toFixed(2))),
    isPlaying: state.isPlaying,
    publisherName: state.publisherName,
    updatedAt: state.updatedAt
  }
}

/**
 * 应用播控端上报的播放状态。
 * 切换歌曲时由播控端上报完整元数据，进度类上报只需携带位置相关字段。
 */
export function applyBroadcastReport(report: BroadcastReport): BroadcastSnapshot | null {
  const songId = toNullableId(report.songId)
  if (songId === null) {
    return null
  }

  const now = getServerTimestamp()
  const duration = toPositiveNumber(report.duration)
  const isPlaying = report.isPlaying !== false
  const songChanged = !state || state.songId !== songId

  // 同一首歌的进度上报沿用已有元数据，避免字段缺失时把歌曲信息清空
  const base: InternalState | null = songChanged ? null : state
  const merged: InternalState = {
    songId,
    scheduleId: songChanged
      ? toNullableId(report.scheduleId)
      : (toNullableId(report.scheduleId) ?? base?.scheduleId ?? null),
    playDate: songChanged
      ? toNullableText(report.playDate, 10)
      : (toNullableText(report.playDate, 10) ?? base?.playDate ?? null),
    sequence: songChanged
      ? toNullableId(report.sequence)
      : (toNullableId(report.sequence) ?? base?.sequence ?? null),
    title: songChanged
      ? toTrimmedText(report.title, 200)
      : toTrimmedText(report.title, 200) || base?.title || '',
    artist: songChanged
      ? toTrimmedText(report.artist, 200)
      : toTrimmedText(report.artist, 200) || base?.artist || '',
    cover: songChanged
      ? toNullableText(report.cover, 1000)
      : (toNullableText(report.cover, 1000) ?? base?.cover ?? null),
    musicPlatform: songChanged
      ? toNullableText(report.musicPlatform, 50)
      : (toNullableText(report.musicPlatform, 50) ?? base?.musicPlatform ?? null),
    musicId: songChanged
      ? toNullableText(report.musicId, 200)
      : (toNullableText(report.musicId, 200) ?? base?.musicId ?? null),
    duration: duration > 0 ? duration : (base?.duration ?? 0),
    isPlaying,
    publisherName: toNullableText(report.publisherName, 100) ?? base?.publisherName ?? null,
    updatedAt: now,
    anchorPosition: toPositiveNumber(report.position),
    anchorAt: now
  }

  state = merged
  return getBroadcastSnapshot()
}

/** 结束广播，学生端随即隐藏「正在播放」 */
export function stopBroadcast(): void {
  state = null
}

/** 对外（开放接口、教室大屏）下发的广播信息，不含播控人身份 */
export interface BroadcastAnnouncement {
  songId: number
  scheduleId: number | null
  playDate: string | null
  sequence: number | null
  title: string
  artist: string
  cover: string | null
  musicPlatform: string | null
  musicId: string | null
  duration: number
  position: number
  isPlaying: boolean
  updatedAt: number
}

export function getBroadcastAnnouncement(): BroadcastAnnouncement | null {
  const snapshot = getBroadcastSnapshot()
  if (!snapshot) return null
  return {
    songId: snapshot.songId,
    scheduleId: snapshot.scheduleId,
    playDate: snapshot.playDate,
    sequence: snapshot.sequence,
    title: snapshot.title,
    artist: snapshot.artist,
    cover: snapshot.cover,
    musicPlatform: snapshot.musicPlatform,
    musicId: snapshot.musicId,
    duration: snapshot.duration,
    position: snapshot.position,
    isPlaying: snapshot.isPlaying,
    updatedAt: snapshot.updatedAt
  }
}
