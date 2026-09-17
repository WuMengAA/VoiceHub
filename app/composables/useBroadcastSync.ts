import { computed, readonly, ref } from 'vue'
import { getSyncedTimestamp, useSyncedTime } from '~/composables/useSyncedTime'
import { useAuth } from '~/composables/useAuth'
import { useAudioPlayer } from '~/composables/useAudioPlayer'
import { useAudioPlayerControl } from '~/composables/useAudioPlayerControl'
import { useSongs } from '~/composables/useSongs'

/** 校园广播「正在播放」状态（与 /api/music/broadcast 返回结构一致） */
export interface BroadcastState {
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
  updatedAt: number
}

/** 播控端上报的字段 */
export interface BroadcastReport {
  songId: number | string
  title?: string | null
  artist?: string | null
  cover?: string | null
  musicPlatform?: string | null
  musicId?: string | null
  duration?: number | null
  position?: number | null
  isPlaying?: boolean
}

// 进度类上报的节流间隔：播放中的进度靠上报锚点 + 本地时钟外推，无需高频上报
const PUBLISH_THROTTLE_MS = 5000
// 跟随收听的漂移容忍度（秒），超过才重新对齐，避免频繁 seek 造成断续
const FOLLOW_DRIFT_TOLERANCE = 4
// 两次对齐之间的最小间隔（毫秒）
const FOLLOW_ALIGN_INTERVAL_MS = 5000
// 跟随播放失败后的重试冷却时长
const FOLLOW_RETRY_COOLDOWN_MS = 60000
// SSE 断开后的兜底轮询间隔
const POLL_INTERVAL_MS = 15000
// 广播状态视为失效的空窗：略大于服务端的播放中空窗（90s），
// 播控端掉线后学生端能自行结束「正在播放」，不必等到下一次拉取
const BROADCAST_IDLE_TIMEOUT_MS = 95000

const FOLLOW_STORAGE_KEY = 'voicehub-broadcast-follow'
const PUBLISH_STORAGE_KEY = 'voicehub-broadcast-publishing'

/** 可用于播控的基准角色（与服务端 BROADCAST_BASELINE_ROLES 保持一致） */
const BROADCAST_BASELINE_ROLES = ['SONG_ADMIN', 'ADMIN', 'SUPER_ADMIN']

/** 播控基准中「人」的展示信息 */
export interface BroadcastAuthorityUser {
  id: number
  name: string
  username: string
  role: string
  grade: string | null
  class: string | null
}

/** 服务端下发的播控基准配置 */
export interface BroadcastAuthorityConfig {
  authority: {
    enabled: boolean
    baselineUserId: number | null
    effectiveBaselineUserId: number | null
    baselineUser: BroadcastAuthorityUser | null
    baselineUserStale: boolean
    roles: string[]
  }
  /** 当前登录者是否具备播控资格（由服务端判定，客户端不再自行推断） */
  canBroadcast: boolean
  /** 不具备资格时的原因：ROLE / STATUS / DISABLED / NOT_BASELINE */
  denyReason: string | null
  /** 是否可修改基准配置（管理员及以上） */
  canEdit: boolean
  /** 可被选为基准播控人的候选用户（仅 canEdit 时下发） */
  candidates: BroadcastAuthorityUser[]
}

// —— 模块级单例：整站共享一条订阅，与 useAudioPlayer 的单例风格一致 ——
const broadcast = ref<BroadcastState | null>(null)
const connected = ref(false)
const followEnabled = ref(false)
// 播控端是否对外广播：默认开启，管理员可在「正在广播」条上结束广播
const publishEnabled = ref(true)
// 播控基准配置：以服务端判定为准，未拉取到时按「无播控权」处理，避免误暴露播控入口
const authorityConfig = ref<BroadcastAuthorityConfig | null>(null)
// 广播进度的本地锚点：收到快照时的（已校时）本地时间戳与进度
const anchorPosition = ref(0)
const anchorAt = ref(0)
const tickNow = ref(0)

let eventSource: EventSource | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let tickTimer: ReturnType<typeof setInterval> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let connectionStarted = false
let lastAlignAt = 0
// 跟随播放失败的歌曲与其失败时间，用于退避重试
let followFailedSongId: number | null = null
let followFailedAt = 0
let lastPublishAt = 0
let publishTimer: ReturnType<typeof setTimeout> | null = null
let pendingReport: BroadcastReport | null = null
let lastPublishedAt = 0

const applySnapshot = (snapshot: BroadcastState | null) => {
  if (!snapshot) {
    broadcast.value = null
    return
  }
  broadcast.value = snapshot
  anchorPosition.value = Number(snapshot.position) || 0
  anchorAt.value = getSyncedTimestamp()
  tickNow.value = anchorAt.value
}

/** 按本地（已校时）时钟外推当前广播进度 */
const computeLivePosition = () => {
  const current = broadcast.value
  if (!current) return 0
  if (!current.isPlaying) return anchorPosition.value
  const elapsed = (getSyncedTimestamp() - anchorAt.value) / 1000
  const position = anchorPosition.value + Math.max(0, elapsed)
  return current.duration > 0 ? Math.min(position, current.duration) : position
}

/** 广播是否仍然有效：播控端停止上报后由本地判定失效，无需等待服务端 */
const isBroadcastAlive = (current: BroadcastState, now: number) => {
  if (!current.isPlaying) return true
  return now - current.updatedAt < BROADCAST_IDLE_TIMEOUT_MS
}

export const useBroadcastSync = () => {
  const auth = useAuth()
  const globalAudioPlayer = useAudioPlayer()
  const control = useAudioPlayerControl()

  const livePosition = computed(() => {
    void tickNow.value
    const current = broadcast.value
    if (!current) return 0
    if (!isBroadcastAlive(current, getSyncedTimestamp())) return anchorPosition.value
    return computeLivePosition()
  })

  const progress = computed(() => {
    const current = broadcast.value
    if (!current || !current.duration) return 0
    return Math.min(1, livePosition.value / current.duration)
  })

  const active = computed(() => broadcast.value !== null)

  /**
   * 当前客户端是否具备播控资格。
   * 判定权在服务端（角色基准 + 指定基准播控人 + 总开关），客户端只做展示——
   * 之前用 isAdmin 本地推断，导致「非基准的歌曲管理员」也能看到播控按钮却上报失败。
   */
  const canPublish = computed(() => Boolean(authorityConfig.value?.canBroadcast))

  /** 是否具备修改基准配置的权限（管理员及以上） */
  const canEditAuthority = computed(() => Boolean(authorityConfig.value?.canEdit))

  /** 当前生效的基准播控人；为空表示按「歌曲管理员及以上」角色放开 */
  const baselineUser = computed(() => authorityConfig.value?.authority.baselineUser ?? null)

  /** 基准配置是否已从服务端取回（用于避免首屏闪出播控入口） */
  const authorityLoaded = computed(() => authorityConfig.value !== null)

  /** 播控总开关是否开启 */
  const authorityEnabled = computed(() => authorityConfig.value?.authority.enabled ?? true)

  /** 不具备播控资格的原因码，便于界面给出人话提示 */
  const denyReason = computed(() => authorityConfig.value?.denyReason ?? null)

  /** 当前广播是否命中某条排期（用于排期列表的「正在播放」标识） */
  const isPlayingSchedule = (scheduleId: number | string, songId?: number | string) => {
    const current = broadcast.value
    if (!current) return false
    if (current.scheduleId !== null && scheduleId !== undefined && scheduleId !== null) {
      return String(current.scheduleId) === String(scheduleId)
    }
    if (songId === undefined || songId === null) return false
    return String(current.songId) === String(songId)
  }

  /** 当前广播是否为指定歌曲（用于歌曲列表的「正在播放」标识） */
  const isPlayingSong = (songId: number | string) => {
    const current = broadcast.value
    return Boolean(current) && String(current.songId) === String(songId)
  }

  // —— 订阅端 ——

  /** 拉取一次当前广播快照，作为 SSE 的首屏兜底与断线兜底 */
  const refresh = async () => {
    if (import.meta.server) return
    try {
      const data = await $fetch<{ broadcast: BroadcastState | null }>('/api/music/broadcast')
      applySnapshot(data?.broadcast ?? null)
    } catch (error) {
      console.error('获取广播状态失败:', error)
    }
  }

  // —— 播控基准 ——

  /** 当前登录者是否属于可播控角色（仅用于决定「要不要去问服务端」，不用于判定能否播控） */
  const isBroadcastStaff = () =>
    BROADCAST_BASELINE_ROLES.includes(auth.user.value?.role || '')

  /**
   * 拉取播控基准配置。
   * 只有歌曲管理员及以上才需要——学生端既不显示播控入口，也不该拿到教职工名单。
   */
  const refreshAuthority = async () => {
    if (import.meta.server) return null
    if (!isBroadcastStaff()) {
      authorityConfig.value = null
      return null
    }
    try {
      const data = await $fetch<BroadcastAuthorityConfig>('/api/music/broadcast/authority')
      authorityConfig.value = data
      return data
    } catch (error) {
      console.error('获取播控基准配置失败:', error)
      return null
    }
  }

  /**
   * 保存播控基准配置（仅管理员及以上可用）。
   * 关闭总开关时服务端会立刻停播，这里同步收起本机的播控开关。
   */
  const saveAuthority = async (payload: { enabled?: boolean; baselineUserId?: number | null }) => {
    if (import.meta.server) return null
    const data = await $fetch<BroadcastAuthorityConfig>('/api/music/broadcast/authority', {
      method: 'POST',
      body: payload
    })
    authorityConfig.value = data
    if (data?.authority?.enabled === false) {
      setPublishEnabled(false)
    }
    return data
  }

  const handleMessage = (payload: any) => {
    if (payload?.type === 'broadcast_state') {
      applySnapshot(payload.data ?? null)
    }
  }

  const scheduleReconnect = () => {
    if (reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      openEventSource()
    }, 5000)
  }

  const openEventSource = () => {
    if (import.meta.server || eventSource) return

    // 携带登录态便于服务端识别身份；匿名同样可订阅
    const token = auth.getToken()
    const url = new URL('/api/music/websocket', window.location.origin)
    if (token) {
      url.searchParams.set('token', token)
    }

    try {
      eventSource = new EventSource(url.toString(), { withCredentials: true })
    } catch (error) {
      console.error('创建广播订阅连接失败:', error)
      scheduleReconnect()
      return
    }

    eventSource.onopen = () => {
      connected.value = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
    }

    eventSource.onmessage = (event) => {
      try {
        handleMessage(JSON.parse(event.data))
      } catch (error) {
        console.error('解析广播消息失败:', error)
      }
    }

    eventSource.onerror = () => {
      connected.value = false
      if (eventSource) {
        eventSource.close()
        eventSource = null
      }
      scheduleReconnect()
    }
  }

  /** 启动订阅（幂等）：SSE 为主，未连通时按固定间隔轮询兜底 */
  const connect = () => {
    if (import.meta.server || connectionStarted) return
    connectionStarted = true
    followEnabled.value =
      typeof localStorage !== 'undefined' && localStorage.getItem(FOLLOW_STORAGE_KEY) === '1'
    publishEnabled.value =
      typeof localStorage === 'undefined' || localStorage.getItem(PUBLISH_STORAGE_KEY) !== '0'

    void useSyncedTime()
      .syncTime()
      .then(() => refresh())
      .catch(() => refresh())

    // 播控基准以服务端为准：管理员改完基准后，其他播控端下次进页面即可看到最新基准
    void refreshAuthority()

    openEventSource()

    if (tickTimer) clearInterval(tickTimer)
    tickTimer = setInterval(() => {
      tickNow.value = getSyncedTimestamp()
      void alignFollowPlayback()
    }, 1000)

    if (pollTimer) clearInterval(pollTimer)
    pollTimer = setInterval(() => {
      if (!connected.value) {
        void refresh()
      }
    }, POLL_INTERVAL_MS)
  }

  const disconnect = () => {
    connectionStarted = false
    connected.value = false
    if (eventSource) {
      eventSource.close()
      eventSource = null
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (tickTimer) {
      clearInterval(tickTimer)
      tickTimer = null
    }
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    broadcast.value = null
  }

  // —— 跟随收听 ——

  /** 学生端可选的「一起听」：把本地播放对齐到广播进度 */
  const alignFollowPlayback = async () => {
    const current = broadcast.value
    if (!followEnabled.value || !current || !isBroadcastAlive(current, getSyncedTimestamp())) {
      return
    }
    if (!current.isPlaying) {
      // 播控端暂停时同步暂停，避免学生端自说自话
      if (globalAudioPlayer.isCurrentSong(current.songId) && globalAudioPlayer.getPlayingStatus().value) {
        globalAudioPlayer.pauseSong()
      }
      return
    }

    // 本机刚做过上报，说明它自己就是播控端，不再跟随自身
    if (getSyncedTimestamp() - lastPublishedAt < 15000) return

    const target = computeLivePosition()
    const localSong = globalAudioPlayer.getCurrentSong().value

    if (!localSong || String(localSong.id) !== String(current.songId)) {
      // 播放失败的曲目短期内不再重试，避免每秒反复触发加载
      if (
        followFailedSongId === current.songId &&
        getSyncedTimestamp() - followFailedAt < FOLLOW_RETRY_COOLDOWN_MS
      ) {
        return
      }
      const song = resolveBroadcastSong(current.songId)
      if (!song) return
      lastAlignAt = getSyncedTimestamp()
      const started = globalAudioPlayer.playSong(song)
      if (!started) {
        followFailedSongId = current.songId
        followFailedAt = getSyncedTimestamp()
        return
      }
      followFailedSongId = null
      globalAudioPlayer.requestSeek(target)
      return
    }

    const drift = Math.abs((globalAudioPlayer.getCurrentPosition().value || 0) - target)
    if (drift > FOLLOW_DRIFT_TOLERANCE && getSyncedTimestamp() - lastAlignAt > FOLLOW_ALIGN_INTERVAL_MS) {
      lastAlignAt = getSyncedTimestamp()
      await control.seek(target)
    }
  }

  /** 从学生端已加载的排期里找出广播中的歌曲，用于跟随播放 */
  const resolveBroadcastSong = (songId: number) => {
    const songs = useSongs()
    const list = songs.publicSchedules?.value || []
    for (const item of list) {
      if (item?.song && String(item.song.id) === String(songId)) {
        return item.song
      }
    }
    return null
  }

  const setFollowEnabled = (enabled: boolean) => {
    followEnabled.value = enabled
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(FOLLOW_STORAGE_KEY, enabled ? '1' : '0')
    }
    if (!enabled) {
      // 关闭跟随后停止本机播放，避免残留声音
      if (broadcast.value && globalAudioPlayer.isCurrentSong(broadcast.value.songId)) {
        globalAudioPlayer.pauseSong()
      }
      return
    }
    void alignFollowPlayback()
  }

  // —— 播控端 ——

  const flushPublish = async () => {
    const report = pendingReport
    pendingReport = null
    if (!report) return
    lastPublishAt = getSyncedTimestamp()
    lastPublishedAt = lastPublishAt
    try {
      await $fetch('/api/music/broadcast', {
        method: 'POST',
        body: report
      })
    } catch (error) {
      console.error('上报广播状态失败:', error)
    }
  }

  /**
   * 上报播放状态。
   * 播放/暂停/切歌/拖动进度用 immediate，播放中的进度更新走节流。
   */
  const publish = (report: BroadcastReport, options: { immediate?: boolean } = {}) => {
    if (import.meta.server || !publishEnabled.value) return
    // 没有播控资格就别上报了：省掉一串注定 403 的请求与刷屏日志
    if (!canPublish.value) return
    const payload: BroadcastReport = {
      songId: Number(report.songId),
      title: report.title ?? null,
      artist: report.artist ?? null,
      cover: report.cover ?? null,
      musicPlatform: report.musicPlatform ?? null,
      musicId: report.musicId ?? null,
      duration: Number(report.duration) || 0,
      position: Number(report.position) || 0,
      isPlaying: report.isPlaying !== false
    }
    if (!Number.isFinite(payload.songId) || (payload.songId as number) <= 0) return

    if (options.immediate) {
      pendingReport = payload
      if (publishTimer) {
        clearTimeout(publishTimer)
        publishTimer = null
      }
      void flushPublish()
      return
    }

    const elapsed = getSyncedTimestamp() - lastPublishAt
    if (elapsed >= PUBLISH_THROTTLE_MS) {
      pendingReport = payload
      void flushPublish()
      return
    }
    pendingReport = payload
    if (!publishTimer) {
      publishTimer = setTimeout(() => {
        publishTimer = null
        void flushPublish()
      }, PUBLISH_THROTTLE_MS - elapsed)
    }
  }

  /** 仅清空服务端广播状态（不改动本机广播开关），用于一曲播完后收尾 */
  const clearBroadcast = async () => {
    if (import.meta.server) return
    pendingReport = null
    if (publishTimer) {
      clearTimeout(publishTimer)
      publishTimer = null
    }
    try {
      await $fetch('/api/music/broadcast', {
        method: 'POST',
        body: { action: 'stop' }
      })
    } catch (error) {
      console.error('清空广播状态失败:', error)
    }
  }

  /** 结束广播：关闭本机广播开关并清空服务端状态，学生端随即隐藏「正在播放」 */
  const stopPublish = async () => {
    setPublishEnabled(false)
    await clearBroadcast()
  }

  /** 开关播控端广播：关闭后本机播放不再对外同步，并立即清空服务端状态 */
  const setPublishEnabled = (enabled: boolean) => {
    publishEnabled.value = enabled
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(PUBLISH_STORAGE_KEY, enabled ? '1' : '0')
    }
    if (!enabled) {
      void clearBroadcast()
    }
  }

  return {
    broadcast: readonly(broadcast),
    connected: readonly(connected),
    followEnabled: readonly(followEnabled),
    publishEnabled: readonly(publishEnabled),
    livePosition,
    progress,
    active,
    /** 当前客户端是否具备播控资格（服务端判定：角色基准 + 基准播控人 + 总开关） */
    canPublish,
    /** 是否可修改基准配置（管理员及以上） */
    canEditAuthority,
    /** 当前生效的基准播控人 */
    baselineUser,
    /** 基准配置是否已从服务端取回 */
    authorityLoaded,
    /** 播控总开关是否开启 */
    authorityEnabled,
    /** 不具备播控资格的原因码 */
    denyReason,
    /** 基准配置原始对象（含候选用户列表） */
    authorityConfig: readonly(authorityConfig),
    isPlayingSchedule,
    isPlayingSong,
    connect,
    disconnect,
    refresh,
    refreshAuthority,
    saveAuthority,
    setFollowEnabled,
    setPublishEnabled,
    publish,
    clearBroadcast,
    stopPublish
  }
}
