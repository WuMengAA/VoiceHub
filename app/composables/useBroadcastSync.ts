import { computed, readonly, ref } from 'vue'
import { getSyncedTimestamp, useSyncedTime } from '~/composables/useSyncedTime'
import { useAuth } from '~/composables/useAuth'
import { useAudioPlayer } from '~/composables/useAudioPlayer'
import type { PlayableSong } from '~/composables/useAudioPlayer'
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
  /** 当前播控人的用户 ID；本机判定「是不是我在播」就靠它 */
  publisherId: number | null
  /** 本次广播会话的开始时间戳 */
  sessionStartedAt: number
  /** 当前收听人数 */
  listenerCount: number
  /** 播放单里的下一首 */
  nextUp: BroadcastQueueItem | null
  /** 队列中还剩几首 */
  queueRemaining: number
}

/** 播放单里的曲目 */
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
// 跟随收听的漂移容忍度（秒）：允许 2 秒误差，差得不多就不校正，避免频繁 seek 显得突兀
const FOLLOW_DRIFT_TOLERANCE = 2
// 两次校正之间的最小间隔（毫秒）：6 秒，兼顾同步灵敏度与 seek 频率
const FOLLOW_ALIGN_INTERVAL_MS = 6000
// 强制对齐漂移阈值（秒）：仅在漂移超出此值（几乎等同于切歌未被捕获）时才强制 seek，
// 作为兜底。普通播放中途的轻微漂移一律不主动 seek，避免被管理端拖动进度条带着听众跳。
const FOLLOW_FORCE_SEEK_DRIFT = 30
// 跟随播放失败后的重试冷却时长
const FOLLOW_RETRY_COOLDOWN_MS = 60000
// SSE 断开后的兜底轮询间隔：SSE 在线时不轮询，断开后 20s 一次（比 15s 少 25% 请求）
const POLL_INTERVAL_MS = 20000
// 收听心跳间隔：告诉服务端「这个页面还在听」（服务端 TTL 45s，30s 续期留有裕量）
const LISTENER_HEARTBEAT_MS = 30000
// 广播状态视为失效的空窗：略大于服务端的播放中空窗（90s），
// 播控端掉线后学生端能自行结束「正在播放」，不必等到下一次拉取
const BROADCAST_IDLE_TIMEOUT_MS = 95000
// SSE 重连指数退避：Vercel 上连接约 60s 被杀，全校同时按固定 5s 重连会形成风暴，
// 改为 1s 起逐次翻倍、上限 30s，把重连高峰摊开
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30000
// 跟随播放解析失败时的提示冷却，避免每秒刷屏
const FOLLOW_WARN_COOLDOWN_MS = 60000

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
    baselineLastActiveAt: number | null
    idleReleaseSec: number
    autoAdvance: boolean
    listenersEnabled: boolean
  }
  /** 当前登录者是否具备播控资格（由服务端判定，客户端不再自行推断） */
  canBroadcast: boolean
  /** 不具备资格时的原因：ROLE / STATUS / DISABLED / NOT_BASELINE */
  denyReason: string | null
  /** 能否立即接管播控权 */
  canTakeover: boolean
  /** 不能接管时的原因：NO_BASELINE / ALREADY_BASELINE / BASELINE_ACTIVE */
  takeoverDenyReason: string | null
  /** 当前是否有广播在播 */
  broadcastActive: boolean
  /** 是否可修改基准配置（管理员及以上） */
  canEdit: boolean
  /** 可被选为基准播控人的候选用户（仅 canEdit 时下发） */
  candidates: BroadcastAuthorityUser[]
}

// —— 模块级单例：整站共享一条订阅，与 useAudioPlayer 的单例风格一致 ——
const broadcast = ref<BroadcastState | null>(null)
const connected = ref(false)
const followEnabled = ref(false)
// 播放单（连播队列）与「下一首」：队列只在播控端用到，学生端只需 nextUp
const queue = ref<BroadcastQueueItem[]>([])
const queueCurrentIndex = ref(-1)
const queueLoaded = ref(false)
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
// SSE 连续重连次数：用于指数退避，连接建立成功后归零
let reconnectAttempts = 0
let tickTimer: ReturnType<typeof setInterval> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let connectionStarted = false
// SSE 连接建立时服务端下发的收听者标识，心跳复用它才能与连接合并成同一条登记
let listenerKey: string | null = null
let lastAlignAt = 0
// 跟随播放失败的歌曲与其失败时间，用于退避重试
let followFailedSongId: number | null = null
let followFailedAt = 0
// 跟随播放解析失败的最后提示时间（带冷却，避免刷屏）
let lastFollowWarnAt = 0
let lastPublishAt = 0
let publishTimer: ReturnType<typeof setTimeout> | null = null
let pendingReport: BroadcastReport | null = null
let lastPublishedAt = 0
// 上一次看到的远端歌曲：用于识别「服务端替我们把曲目推进了」
let lastRemoteSongId: number | null = null

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

  /** 能否接管播控权（服务端判定：对方失联或无人占位） */
  const canTakeover = computed(() => Boolean(authorityConfig.value?.canTakeover))

  /** 不能接管时的原因码：NO_BASELINE / ALREADY_BASELINE / BASELINE_ACTIVE */
  const takeoverDenyReason = computed(() => authorityConfig.value?.takeoverDenyReason ?? null)

  /** 是否开自动连播（曲目播完自动切下一首） */
  const autoAdvance = computed(() => authorityConfig.value?.authority.autoAdvance ?? false)

  /** 是否统计在线收听人数 */
  const listenersEnabled = computed(
    () => authorityConfig.value?.authority.listenersEnabled ?? true
  )

  /** 当前广播是不是本机在播（避免播控端自己跟随自己的广播） */
  const isSelfBroadcasting = computed(() => {
    const current = broadcast.value
    const userId = auth.user.value?.id
    if (!current || !userId) return false
    return current.publisherId !== null && String(current.publisherId) === String(userId)
  })

  /** 当前收听人数（关闭统计时为 0） */
  const listenerCount = computed(() =>
    listenersEnabled.value ? Number(broadcast.value?.listenerCount) || 0 : 0
  )

  /** 播放单里当前曲目之后的待播条目 */
  const upcomingQueue = computed(() => queue.value.slice(queueCurrentIndex.value + 1))

  /** 播放单里已经播过的条目 */
  const playedQueue = computed(() =>
    queueCurrentIndex.value >= 0 ? queue.value.slice(0, queueCurrentIndex.value) : []
  )

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
      // 轮询兜底场景同样立即对齐（SSE 断开时保持同步灵敏度）
      void alignFollowPlayback()
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
  const saveAuthority = async (payload: {
    enabled?: boolean
    baselineUserId?: number | null
    autoAdvance?: boolean
    idleReleaseSec?: number
    listenersEnabled?: boolean
  }) => {
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

  /**
   * 接管播控权：把自己设为基准播控人。
   * 服务端会在接管时结束当前广播，这里顺带刷新一次播放单，便于接管后立刻排新单。
   */
  const takeoverAuthority = async () => {
    if (import.meta.server) return null
    const data = await $fetch<BroadcastAuthorityConfig>('/api/music/broadcast/authority', {
      method: 'POST',
      body: { action: 'claim' }
    })
    authorityConfig.value = data
    await refreshQueue()
    return data
  }

  /** 交还播控权：改回「歌曲管理员及以上都能播」 */
  const releaseAuthority = async () => {
    if (import.meta.server) return null
    const data = await $fetch<BroadcastAuthorityConfig>('/api/music/broadcast/authority', {
      method: 'POST',
      body: { action: 'release' }
    })
    authorityConfig.value = data
    return data
  }

  // —— 播放单 ——

  /** 读取播放单（需要歌曲管理员及以上） */
  const refreshQueue = async () => {
    if (import.meta.server || !isBroadcastStaff()) {
      queue.value = []
      queueCurrentIndex.value = -1
      queueLoaded.value = false
      return null
    }
    try {
      const data = await $fetch<{
        queue: BroadcastQueueItem[]
        currentIndex: number
      }>('/api/music/broadcast/queue')
      queue.value = data?.queue ?? []
      queueCurrentIndex.value = Number(data?.currentIndex ?? -1) || -1
      queueLoaded.value = true
      return data
    } catch (error) {
      // 非基准播控人拿不到播放单是正常的（403），不必刷日志
      queueLoaded.value = false
      return null
    }
  }

  /**
   * 保存播放单。
   * @param songIds 按顺序提交的曲目 ID 列表；空数组表示清空
   */
  const saveQueue = async (songIds: number[]) => {
    if (import.meta.server) return null
    const data = await $fetch<{ queue: BroadcastQueueItem[]; currentIndex: number }>(
      '/api/music/broadcast/queue',
      {
        method: 'POST',
        body: { songIds }
      }
    )
    queue.value = data?.queue ?? []
    queueCurrentIndex.value = Number(data?.currentIndex ?? -1) || -1
    queueLoaded.value = true
    return data
  }

  /** 手动切到播放单的下一首 */
  const playNext = async () => {
    if (import.meta.server) return null
    await $fetch('/api/music/broadcast', {
      method: 'POST',
      body: { action: 'next' }
    })
    return true
  }

  /** 收听心跳：告诉服务端这个页面还在听 */
  const sendListenerHeartbeat = async () => {
    if (import.meta.server || !listenerKey) return
    try {
      await $fetch('/api/music/broadcast/listeners', {
        method: 'POST',
        body: { connectionId: listenerKey.replace(/^anon:/, '') }
      })
    } catch {
      // 心跳失败无所谓，下一次周期会重试；SSE 连接本身也在计数
    }
  }

  const handleMessage = (payload: any) => {
    if (payload?.type === 'broadcast_state') {
      applySnapshot(payload.data ?? null)
      // SSE 消息到达即触发跟随对齐，不必等 1s tick：切歌/播放/暂停响应更灵敏
      void alignFollowPlayback()
      return
    }
    if (payload?.type === 'connection_established') {
      // 服务端给的统一标识：后续心跳带上它，才能让「连接」与「心跳」合并成一个人头
      listenerKey = payload.data?.listenerKey ?? null
    }
  }

  const scheduleReconnect = () => {
    if (reconnectTimer) return
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempts)
    reconnectAttempts++
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      openEventSource()
    }, delay)
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
      // 连接成功，重连计数归零，下次断线仍从 1s 开始退避
      reconnectAttempts = 0
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
      void followServerAdvance()
    }, 1000)

    if (pollTimer) clearInterval(pollTimer)
    pollTimer = setInterval(() => {
      if (!connected.value) {
        void refresh()
      }
    }, POLL_INTERVAL_MS)

    // 收听心跳：SSE 断开时这一份登记会随之过期，不会长期把人数算多
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    heartbeatTimer = setInterval(() => {
      void sendListenerHeartbeat()
    }, LISTENER_HEARTBEAT_MS)
    void sendListenerHeartbeat()
  }

  const disconnect = () => {
    connectionStarted = false
    connected.value = false
    reconnectAttempts = 0
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
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
    listenerKey = null
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
      const song = resolveBroadcastSong(current)
      if (!song) {
        // 广播不携带可播信息（无平台/无 id）：提示一次并进入退避，避免静默失败
        if (getSyncedTimestamp() - lastFollowWarnAt > FOLLOW_WARN_COOLDOWN_MS) {
          lastFollowWarnAt = getSyncedTimestamp()
          if (window.$showNotification) {
            window.$showNotification('当前广播歌曲暂不支持跟随播放', 'info')
          }
        }
        followFailedSongId = current.songId
        followFailedAt = getSyncedTimestamp()
        return
      }
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
    // 跟随端只在「切歌瞬间」对齐一次进度（上面 songId 变化时已 requestSeek）；
    // 进入稳定播放后不再因漂移主动 seek，避免被管理端中途拖动进度条带着听众跳，保证听感连续。
    // 仅当漂移超过 30 秒（几乎等同于切歌未被捕获）才做一次强制对齐兜底。
    if (drift > FOLLOW_FORCE_SEEK_DRIFT && getSyncedTimestamp() - lastAlignAt > FOLLOW_ALIGN_INTERVAL_MS) {
      lastAlignAt = getSyncedTimestamp()
      await control.seek(target)
    }
  }

  /**
   * 播控端跟随服务端的连播推进。
   *
   * 服务端没有「替客户端按下播放键」的能力：它只能把权威状态切到下一首。
   * 所以这里盯着广播的 songId——一旦它变了，且本机确实正在播控（近期有上报），
   * 就加载并播放这首新歌，让自动连播真正发出声音。
   */
  const followServerAdvance = async () => {
    const current = broadcast.value
    if (!current || !canPublish.value || !publishEnabled.value) return
    // 近期没有上报过说明这台机器当下不在播控，别自作主张替别人放歌
    if (getSyncedTimestamp() - lastPublishedAt > 60_000) return
    if (lastRemoteSongId === current.songId) return

    const seen = lastRemoteSongId
    lastRemoteSongId = current.songId
    // 首帧只记录、不播；暂停中的广播也不自动开声
    if (seen === null || !current.isPlaying) return

    const localSong = globalAudioPlayer.getCurrentSong().value
    if (localSong && String(localSong.id) === String(current.songId)) return

    const song = resolveBroadcastSong(current)
    if (!song) return
    if (followFailedSongId === current.songId && getSyncedTimestamp() - followFailedAt < FOLLOW_RETRY_COOLDOWN_MS) {
      return
    }
    const started = globalAudioPlayer.playSong(song)
    if (!started) {
      followFailedSongId = current.songId
      followFailedAt = getSyncedTimestamp()
    }
  }

  /**
   * 解析广播中的歌曲用于跟随播放（一起听协同）。
   * 优先用学生端已加载排期里的完整歌曲对象（可能带 playUrl 等额外信息）；
   * 找不到时直接使用广播快照自带的音乐信息构造可播放对象——
   * 广播推送「正在播放」时本就携带 musicPlatform/musicId/封面等，学生端不依赖排期也能协同播放。
   */
  const resolveBroadcastSong = (current: BroadcastState): PlayableSong | null => {
    const songs = useSongs()
    const list = songs.publicSchedules?.value || []
    for (const item of list) {
      if (item?.song && String(item.song.id) === String(current.songId)) {
        return item.song
      }
    }
    // 兜底：广播快照自带音乐信息，直接构造成可播放对象
    if (current.musicPlatform && current.musicId) {
      return {
        id: current.songId,
        title: current.title || '',
        artist: current.artist || '',
        cover: current.cover,
        duration: current.duration > 0 ? current.duration : undefined,
        musicPlatform: current.musicPlatform,
        musicId: current.musicId
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
    /** 能否接管播控权（对方失联或无人占位） */
    canTakeover,
    /** 不能接管的原因码：NO_BASELINE / ALREADY_BASELINE / BASELINE_ACTIVE */
    takeoverDenyReason,
    /** 是否开启自动连播 */
    autoAdvance,
    /** 是否统计在线收听人数 */
    listenersEnabled,
    /** 当前收听人数 */
    listenerCount,
    /** 当前广播是否为本机在播 */
    isSelfBroadcasting,
    /** 基准配置原始对象（含候选用户列表） */
    authorityConfig: readonly(authorityConfig),
    /** 播放单（连播队列） */
    queue: readonly(queue),
    /** 当前曲目在播放单中的下标 */
    queueCurrentIndex: readonly(queueCurrentIndex),
    /** 播放单是否已从服务端取回 */
    queueLoaded: readonly(queueLoaded),
    /** 待播曲目 */
    upcomingQueue,
    /** 已播曲目 */
    playedQueue,
    isPlayingSchedule,
    isPlayingSong,
    connect,
    disconnect,
    refresh,
    refreshAuthority,
    saveAuthority,
    takeoverAuthority,
    releaseAuthority,
    refreshQueue,
    saveQueue,
    playNext,
    setFollowEnabled,
    setPublishEnabled,
    publish,
    clearBroadcast,
    stopPublish
  }
}
