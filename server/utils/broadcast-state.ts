/**
 * 校园广播「正在播放」权威状态
 *
 * 播控端（歌曲管理员及以上）在播放、暂停、切歌、拖动进度时向服务端上报；
 * 服务端只保存一份权威状态，并向所有 SSE 订阅者与开放接口下发，
 * 学生端据此同步当前歌曲与播放进度。
 *
 * 在播状态仅保存在进程内存中：广播是实时行为，服务重启后由播控端下一次上报重建，
 * 因此不落库。但**每一次播出的起止都会落到 BroadcastPlayLog**（见 broadcast-logs.ts），
 * 这里只以「事件」的形式把起止抛出去，不碰数据库——保证本模块可被纯 Node 单测。
 *
 * 本模块承担四件事：
 * 1. 实时状态与进度外推（播控端只上报锚点，剩余由服务器时间推算）
 * 2. 播放单队列与「下一首」预告，播完可自动连播
 * 3. 播出会话起止事件（供播出日志落库）
 * 4. 在线收听人数（由 broadcast-listeners 提供计数，这里只负责组装）
 */
import { getServerTimestamp } from './serverTime.ts'
import { countActiveListeners, touchListener } from './broadcast-listeners.ts'

// 播放中无上报的容错窗口，超过即认为播控端已离线
const PLAYING_STALE_MS = 90_000
// 暂停状态保留时长，超时后失效，避免学生端长期停留在「已暂停」
const PAUSED_STALE_MS = 30 * 60_000
// 进度超出总时长的容错秒数，超过即认定本曲已播完
const END_TOLERANCE_SECONDS = 5
// 队列最多保留的曲目数，防止把整个学期的排期塞进来
const MAX_QUEUE_LENGTH = 200

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

/** 播放单里的曲目（由服务端根据当日排期补全元数据，播控端只需提交 songId） */
export interface BroadcastQueueItem {
  songId: number
  title: string
  artist: string
  cover: string | null
  musicPlatform: string | null
  musicId: string | null
  duration: number
  scheduleId: number | null
  playDate: string | null
  sequence: number | null
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
  /** 当前播控人的用户 ID（用于「是不是我自己在上报」的判定） */
  publisherId: number | null
  /** 本次广播会话（连续播出这一段）的开始时间戳 */
  sessionStartedAt: number
  /** 当前收听人数（统计关闭时为 0） */
  listenerCount: number
  /** 播放单里的下一首；无连播队列时为 null */
  nextUp: BroadcastQueueItem | null
  /** 队列中当前曲目之后还剩几首 */
  queueRemaining: number
}

/** 播出日志结束原因 */
export type BroadcastEndReason =
  | 'STOPPED'
  | 'SWITCHED'
  | 'AUTO_ADVANCED'
  | 'EXPIRED'
  | 'DISABLED'
  | 'TAKEOVER'

/** 抛给落库侧的播出事件：一条播完导出一条日志 */
export interface BroadcastPlayLogEvent {
  type: 'start' | 'end'
  songId: number
  title: string
  artist: string
  cover: string | null
  scheduleId: number | null
  playDate: string | null
  sequence: number | null
  publisherId: number | null
  publisherName: string | null
  /** start 事件的开播时间；end 事件沿用同一会话的开播时间 */
  startedAt: number
  /** 仅 end 事件有值 */
  endedAt?: number
  /** 实际播出秒数（不含暂停），仅 end 事件有值 */
  playedSeconds?: number
  /** 仅 end 事件有值 */
  endReason?: BroadcastEndReason
  /** 播出期间的收听人数峰值，仅 end 事件有值 */
  listenerPeak?: number
}

interface InternalState extends Omit<BroadcastSnapshot, 'position' | 'listenerCount' | 'nextUp' | 'queueRemaining'> {
  /** 上报时刻的进度，实时进度由此按服务器时间外推 */
  anchorPosition: number
  /** 上报时刻的服务器时间戳 */
  anchorAt: number
  /** 本会话累计的有效播放秒数（暂停不计） */
  accumulatedSeconds: number
  /** 当前这段连续播放的起点时间戳；暂停时为 null */
  segmentStartedAt: number | null
  /** 播出期间的收听人数峰值 */
  listenerPeak: number
}

let state: InternalState | null = null
let queueItems: BroadcastQueueItem[] = []
/** 当前曲目在播放单中的下标；-1 表示当前曲目不在播放单里 */
let queueIndex = -1

// —— 播出日志事件 ——
// 无 sink 时事件堆积在内存里由调用方取走；注册 sink 后由 sink 直接落库。
// 限制队列长度，避免落库侧长期不可用导致内存膨胀。
const MAX_PENDING_EVENTS = 200
let playLogEvents: BroadcastPlayLogEvent[] = []
let playLogSink: ((event: BroadcastPlayLogEvent) => void) | null = null

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

/** 注册播出日志落库回调（由 server/plugins 在服务启动时调用） */
export function setPlayLogSink(sink: ((event: BroadcastPlayLogEvent) => void) | null): void {
  playLogSink = sink
}

export function emitPlayLogEvent(event: BroadcastPlayLogEvent): void {
  if (playLogSink) {
    try {
      playLogSink(event)
    } catch (error) {
      console.error('[broadcast] 播出日志落库失败:', error)
    }
    return
  }
  playLogEvents.push(event)
  if (playLogEvents.length > MAX_PENDING_EVENTS) {
    playLogEvents.splice(0, playLogEvents.length - MAX_PENDING_EVENTS)
  }
}

/** 取出暂存的播出日志事件（未注册 sink 时使用），取出后清空 */
export function consumePlayLogEvents(): BroadcastPlayLogEvent[] {
  if (playLogEvents.length === 0) return []
  const events = playLogEvents
  playLogEvents = []
  return events
}

/** 当前曲目按服务器时间外推后的进度；不修改任何状态 */
const projectPosition = (current: InternalState, now: number): number => {
  let position = current.anchorPosition
  if (current.isPlaying) {
    position = current.anchorPosition + (now - current.anchorAt) / 1000
  }
  if (current.duration > 0) {
    position = Math.min(position, current.duration)
  }
  return Math.max(0, position)
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

/** 结算当前会话的累计播放秒数（把当前这段正在播放的时间算进去） */
const settlePlayedSeconds = (current: InternalState, now: number): number => {
  let total = current.accumulatedSeconds
  if (current.segmentStartedAt !== null) {
    total += Math.max(0, (now - current.segmentStartedAt) / 1000)
  }
  return Math.round(total)
}

/** 关闭当前播出会话并抛出一条 end 事件 */
const finalizeSession = (current: InternalState, now: number, reason: BroadcastEndReason): void => {
  const playedSeconds = settlePlayedSeconds(current, now)
  emitPlayLogEvent({
    type: 'end',
    songId: current.songId,
    title: current.title,
    artist: current.artist,
    cover: current.cover,
    scheduleId: current.scheduleId,
    playDate: current.playDate,
    sequence: current.sequence,
    publisherId: current.publisherId,
    publisherName: current.publisherName,
    startedAt: current.sessionStartedAt,
    endedAt: now,
    playedSeconds,
    endReason: reason,
    listenerPeak: Math.max(current.listenerPeak, countActiveListeners(now))
  })
}

const openSession = (current: InternalState): void => {
  emitPlayLogEvent({
    type: 'start',
    songId: current.songId,
    title: current.title,
    artist: current.artist,
    cover: current.cover,
    scheduleId: current.scheduleId,
    playDate: current.playDate,
    sequence: current.sequence,
    publisherId: current.publisherId,
    publisherName: current.publisherName,
    startedAt: current.sessionStartedAt
  })
}

/**
 * 获取当前广播状态快照。
 * 无广播或状态已过期时返回 null，调用方应据此隐藏「正在播放」相关界面。
 * @param now 参考时间戳，默认取服务器当前时间（测试可注入以便校验过期判定）
 */
export function getBroadcastSnapshot(now: number = getServerTimestamp()): BroadcastSnapshot | null {
  if (!state) return null

  if (isExpired(state, now)) {
    finalizeSession(state, now, 'EXPIRED')
    state = null
    return null
  }

  const listenerCount = countActiveListeners(now)
  if (listenerCount > state.listenerPeak) {
    state.listenerPeak = listenerCount
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
    position: Number(projectPosition(state, now).toFixed(2)),
    isPlaying: state.isPlaying,
    publisherName: state.publisherName,
    publisherId: state.publisherId,
    sessionStartedAt: state.sessionStartedAt,
    updatedAt: state.updatedAt,
    listenerCount,
    nextUp: getNextQueueItem(),
    queueRemaining: Math.max(0, queueItems.length - queueIndex - 1)
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

  // 暂停 → 播放 / 播放 → 暂停：结算上一段的有效播放时长
  let accumulatedSeconds = 0
  let segmentStartedAt: number | null = null
  if (base) {
    accumulatedSeconds = base.accumulatedSeconds
    if (base.isPlaying && base.segmentStartedAt !== null) {
      accumulatedSeconds += (now - base.segmentStartedAt) / 1000
    }
    segmentStartedAt = isPlaying ? now : null
  } else {
    segmentStartedAt = isPlaying ? now : null
  }

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
    publisherId: toNullableId(report.publisherId) ?? base?.publisherId ?? null,
    publisherName: toNullableText(report.publisherName, 100) ?? base?.publisherName ?? null,
    updatedAt: now,
    sessionStartedAt: base?.sessionStartedAt ?? now,
    anchorPosition: toPositiveNumber(report.position),
    anchorAt: now,
    accumulatedSeconds,
    segmentStartedAt,
    listenerPeak: Math.max(base?.listenerPeak ?? 0, countActiveListeners(now))
  }

  // 切歌：结算上一首的播出日志，并为新歌开一次会话
  if (state && songChanged) {
    finalizeSession(state, now, 'SWITCHED')
  }

  state = merged
  if (songChanged) {
    openSession(merged)
    // 手动切歌时把队列游标同步到这首的位置（若它在播放单里），
    // 这样「下一首」始终跟着实际播出走，而不是只跟着上报顺序
    queueIndex = queueItems.findIndex((item) => item.songId === songId)
  }

  return getBroadcastSnapshot()
}

/** 结束广播，学生端随即隐藏「正在播放」 */
export function stopBroadcast(reason: BroadcastEndReason = 'STOPPED'): void {
  if (state) {
    finalizeSession(state, getServerTimestamp(), reason)
  }
  state = null
}

// —— 播放单（连播队列） ——

/** 当前曲目的下一首；已达队列末尾或没有队列时返回 null */
export function getNextQueueItem(): BroadcastQueueItem | null {
  if (queueItems.length === 0) return null
  const next = queueIndex + 1
  return next < queueItems.length ? queueItems[next] : null
}

/** 完整播放单（含已播过的），供播控界面展示与编辑 */
export function getBroadcastQueue(): { items: BroadcastQueueItem[]; currentIndex: number } {
  return { items: [...queueItems], currentIndex: queueIndex }
}

/**
 * 替换播放单。
 * 若当前正在播的曲目仍在新队列里，游标保持在它的位置；否则游标回到 -1，
 * 此时「下一首」取队列第一条——避免播到一半改单后跳到莫名其妙的位置。
 */
export function setBroadcastQueue(
  items: BroadcastQueueItem[],
  currentSongId: number | null = state?.songId ?? null
): BroadcastQueueItem[] {
  queueItems = items.slice(0, MAX_QUEUE_LENGTH)
  const found = currentSongId === null ? -1 : queueItems.findIndex((item) => item.songId === currentSongId)
  queueIndex = found
  return [...queueItems]
}

export function clearBroadcastQueue(): void {
  queueItems = []
  queueIndex = -1
}

/**
 * 连播到播放单的下一首。
 * 服务端没有「替播控端播放」的能力，这里做的是把权威状态切到下一首并置为播放中，
 * 播控端收到 SSE 快照发现 songId 变了，即加载并播放该曲目。
 *
 * @returns 新的广播快照；队列已播完或没有队列时返回 null
 */
export function advanceBroadcast(reason: BroadcastEndReason = 'AUTO_ADVANCED'): BroadcastSnapshot | null {
  const next = getNextQueueItem()
  if (!next) return null

  const now = getServerTimestamp()

  if (state) {
    finalizeSession(state, now, reason)
  }

  queueIndex += 1
  state = {
    songId: next.songId,
    scheduleId: next.scheduleId,
    playDate: next.playDate,
    sequence: next.sequence,
    title: next.title,
    artist: next.artist,
    cover: next.cover,
    musicPlatform: next.musicPlatform,
    musicId: next.musicId,
    duration: next.duration,
    isPlaying: true,
    publisherId: state?.publisherId ?? null,
    publisherName: state?.publisherName ?? null,
    updatedAt: now,
    sessionStartedAt: now,
    anchorPosition: 0,
    anchorAt: now,
    accumulatedSeconds: 0,
    segmentStartedAt: now,
    listenerPeak: countActiveListeners(now)
  }
  openSession(state)
  return getBroadcastSnapshot(now)
}

/** 当前曲目是否已经播到结尾（含容错） */
export const hasCurrentTrackFinished = (now: number = getServerTimestamp()): boolean => {
  if (!state || state.duration <= 0) return false
  return projectPosition(state, now) >= state.duration - 0.5
}

/**
 * 会话同步：广播存在时按服务端时钟检查当前曲是否已播完，
 * 开启自动连播且播放单里还有下一首就推进到下一首。
 *
 * 之所以做成显式调用而不是塞进 getBroadcastSnapshot：读接口应当没有副作用，
 * 否则一次纯查询就会改写播出状态、并让「过期判定」的单测变得难以理解。
 *
 * @returns 状态是否发生了变化（变化时需要向订阅者推送新快照）
 */
export function syncBroadcastSession(options: {
  autoAdvance?: boolean
  now?: number
} = {}): { changed: boolean; snapshot: BroadcastSnapshot | null } {
  const now = options.now ?? getServerTimestamp()

  if (!state) {
    return { changed: false, snapshot: null }
  }

  // 自动连播只在「播控端还在线」时替它切歌：
  // 超过失联窗口说明人已经跑了，这时候凭空替他开下一首是错的，交给过期逻辑收尾。
  if (
    options.autoAdvance &&
    state.isPlaying &&
    now - state.updatedAt <= PLAYING_STALE_MS &&
    hasCurrentTrackFinished(now)
  ) {
    const advanced = advanceBroadcast('AUTO_ADVANCED')
    if (advanced) {
      return { changed: true, snapshot: advanced }
    }
  }

  // 播控端掉线太久导致的过期由这里结算，广播就此收起
  const current = getBroadcastSnapshot(now)
  if (!current) {
    return { changed: true, snapshot: null }
  }

  return { changed: false, snapshot: current }
}

/** 记录一次收听心跳：学生端在「一起听」或页面停留时上报 */
export function reportListenerHeartbeat(listenerKey: string, now: number = getServerTimestamp()): number {
  touchListener(listenerKey, now)
  return countActiveListeners(now)
}

// —— 对外（开放接口、教室大屏）——

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
  /** 当前收听人数（关闭统计时为 0） */
  listenerCount: number
  /** 下一首预告（不含播控人身份） */
  nextUp: {
    songId: number
    title: string
    artist: string
    cover: string | null
    duration: number
    scheduleId: number | null
    sequence: number | null
  } | null
  /** 队列中当前曲目之后还剩几首 */
  queueRemaining: number
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
    updatedAt: snapshot.updatedAt,
    listenerCount: snapshot.listenerCount,
    nextUp: snapshot.nextUp
      ? {
          songId: snapshot.nextUp.songId,
          title: snapshot.nextUp.title,
          artist: snapshot.nextUp.artist,
          cover: snapshot.nextUp.cover,
          duration: snapshot.nextUp.duration,
          scheduleId: snapshot.nextUp.scheduleId,
          sequence: snapshot.nextUp.sequence
        }
      : null,
    queueRemaining: snapshot.queueRemaining
  }
}
