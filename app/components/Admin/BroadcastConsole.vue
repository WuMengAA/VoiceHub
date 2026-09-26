<template>
  <div class="console">
    <!-- 播控状态条：始终可见，未开播时说明当前处于什么状态，避免管理员对着没反应的面板猜 -->
    <div class="status-bar" :class="{ live: !!broadcast }">
      <span class="status-dot" :class="{ live: !!broadcast }" />
      <div class="status-text">
        <p class="status-title">{{ statusTitle }}</p>
        <p class="status-hint">{{ statusHint }}</p>
      </div>
      <div class="status-actions">
        <button
          v-if="canPublish && !publishEnabled"
          class="btn accent"
          type="button"
          @click="enablePublish"
        >
          {{ locale.startBroadcast }}
        </button>
        <button
          v-if="canPublish && broadcast && broadcast.nextUp"
          class="btn"
          type="button"
          @click="handlePlayNext"
        >
          {{ locale.playNext }}
        </button>
        <button
          v-if="canPublish && broadcast"
          class="btn"
          type="button"
          @click="handleStopBroadcast"
        >
          {{ locale.stopBroadcast }}
        </button>
      </div>
    </div>

    <div class="console-body">
      <!-- 左栏：歌曲库（选歌入口） -->
      <section class="panel">
        <header class="panel-head">
          <h4 class="panel-title">{{ t.library }}</h4>
          <span class="panel-meta">{{ libraryCountText }}</span>
        </header>
        <div class="panel-search">
          <input
            v-model="keyword"
            class="search-input"
            type="search"
            :placeholder="t.searchPlaceholder"
          >
        </div>
        <ul class="rows">
          <li v-for="song in filteredLibrary" :key="song.id" class="row">
            <span class="row-main">
              <span class="row-title">{{ song.title }}</span>
              <span class="row-sub">{{ song.artist }}</span>
            </span>
            <button
              class="btn tiny"
              type="button"
              :disabled="isInQueue(song.id)"
              @click="addToQueue(song)"
            >
              {{ isInQueue(song.id) ? t.inQueue : t.addToQueue }}
            </button>
          </li>
          <li v-if="filteredLibrary.length === 0" class="row empty">
            {{ t.libraryEmpty }}
          </li>
        </ul>
      </section>

      <!-- 右栏：播放单（顺序即播出顺序） -->
      <section class="panel">
        <header class="panel-head">
          <h4 class="panel-title">{{ locale.queueTitle }}</h4>
          <button v-if="draft.length > 0" class="link" type="button" @click="clearDraft">
            {{ locale.queueClear }}
          </button>
        </header>
        <p class="panel-hint">{{ t.queueHint }}</p>
        <ul class="rows">
          <li
            v-for="(item, index) in draft"
            :key="`${item.songId}-${index}`"
            class="row"
            :class="{ current: index === liveIndex }"
          >
            <span class="row-index">{{ index + 1 }}</span>
            <span class="row-main">
              <span class="row-title">{{ item.title }}</span>
              <span class="row-sub">{{ item.artist }}</span>
            </span>
            <span v-if="index === liveIndex" class="row-badge">{{ t.current }}</span>
            <button
              class="icon-btn"
              type="button"
              :disabled="index === 0"
              :title="t.moveUp"
              @click="moveItem(index, -1)"
            >
              ↑
            </button>
            <button
              class="icon-btn"
              type="button"
              :disabled="index === draft.length - 1"
              :title="t.moveDown"
              @click="moveItem(index, 1)"
            >
              ↓
            </button>
            <button
              class="icon-btn"
              type="button"
              :title="t.playThis"
              :disabled="!isPlayable(item.songId)"
              @click="playItem(item)"
            >
              <Icon :size="12" name="play" />
            </button>
            <button class="icon-btn" type="button" :title="t.remove" @click="removeItem(index)">
              <Icon :size="12" name="x" />
            </button>
          </li>
          <li v-if="draft.length === 0" class="row empty">
            {{ locale.queueEmpty }}
          </li>
        </ul>
        <footer class="panel-foot">
          <label class="switch">
            <input
              v-model="autoAdvanceDraft"
              type="checkbox"
              :disabled="!canEditAuthority"
              @change="handleAutoAdvanceChange"
            >
            <span>{{ locale.autoAdvanceLabel }}</span>
          </label>
          <button
            class="btn accent"
            type="button"
            :disabled="saving || !dirty"
            @click="handleSave"
          >
            {{ saving ? t.saving : t.save }}
          </button>
        </footer>
      </section>
    </div>
  </div>
</template>

<script setup>
/**
 * 音乐管理员播控台。
 *
 * 职责边界：本页只做「选歌 → 排播放单 → 播控」这条链路。
 * 歌曲本身的增删改仍走「歌曲管理」页，避免把两类操作混在一处。
 *
 * 复用点（不另起一套）：
 * - 播放单读写走 useBroadcastSync 的 refreshQueue / saveQueue（服务端 /api/music/broadcast/queue）
 * - 自动连播与播控基准走 saveAuthority
 * - 播放走全局 AudioPlayer（app.vue 挂载）；播控端的播放上报由 AudioPlayer 内部自动完成，
 *   本页不重复上报，避免同一进度被写两次。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import Icon from '~/components/UI/Icon.vue'
import { useLocale } from '~/utils/locale'
import { useToast } from '~/composables/useToast'
import { useBroadcastSync } from '~/composables/useBroadcastSync'
import { useSongs } from '~/composables/useSongs'
import { useSongPlayer } from '~/composables/useSongPlayer'

const { songs: songsLocale } = useLocale()
const locale = computed(() => songsLocale.value?.broadcast || {})
/** 播控台专有文案；缺语言包时给出中文兜底，避免出现空白按钮 */
const t = computed(() => {
  const fallback = {
    library: '歌曲库',
    searchPlaceholder: '搜索歌曲名或歌手',
    libraryEmpty: '没有匹配的歌曲',
    libraryCount: (count) => `共 ${count} 首`,
    addToQueue: '加入播放单',
    inQueue: '已在播放单',
    queueHint: '顺序即播出顺序，可用 ↑ ↓ 调整',
    moveUp: '上移',
    moveDown: '下移',
    playThis: '播放这首',
    remove: '移出播放单',
    save: '保存播放单',
    saving: '保存中…',
    saved: '播放单已保存',
    saveFailed: '保存播放单失败',
    loadFailed: '读取播放单失败',
    notPlayable: '这首歌没有可用的播放来源',
    current: '正在播',
    readyHint: '从左侧挑歌排好播放单，点播放即开始广播',
    noPermissionHint: '当前账号不具备播控资格，可在播控设置里指定基准播控人'
  }
  return { ...fallback, ...(locale.value.console || {}) }
})

const toast = useToast()
const broadcastSync = useBroadcastSync()
const songsStore = useSongs()
const { playSong } = useSongPlayer()

const broadcast = broadcastSync.broadcast
const canPublish = broadcastSync.canPublish
const canEditAuthority = broadcastSync.canEditAuthority
const publishEnabled = broadcastSync.publishEnabled
const listenerCount = broadcastSync.listenerCount
const liveIndex = broadcastSync.queueCurrentIndex

/** 列表上限：整库一次性渲染会拖慢后台，靠搜索收敛 */
const MAX_ROWS = 200

const keyword = ref('')
const draft = ref([])
const saving = ref(false)
const autoAdvanceDraft = ref(false)
/** 上次保存成功时的曲目序列，用于判断「有未保存改动」 */
const savedKey = ref('')

const library = computed(() => songsStore.visibleSongs?.value || [])

const filteredLibrary = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  const matched = kw
    ? library.value.filter((song) =>
        `${song.title || ''} ${song.artist || ''}`.toLowerCase().includes(kw)
      )
    : library.value
  return matched.slice(0, MAX_ROWS)
})

const libraryCountText = computed(() => t.value.libraryCount(filteredLibrary.value.length))

/** 只有拿得到完整歌曲对象（含音源信息）的曲目才允许直接播 */
const playableIds = computed(() => new Set(library.value.map((song) => Number(song.id))))

const currentKey = computed(() => draft.value.map((item) => item.songId).join(','))
const dirty = computed(() => currentKey.value !== savedKey.value)

const isInQueue = (songId) => draft.value.some((item) => item.songId === Number(songId))
const isPlayable = (songId) => playableIds.value.has(Number(songId))

const statusTitle = computed(() => {
  if (broadcast.value) {
    const artist = broadcast.value.artist ? ` - ${broadcast.value.artist}` : ''
    return `${broadcast.value.title || locale.value.unknownSong}${artist}`
  }
  return canPublish.value ? locale.value.staffReady : locale.value.noPermission
})

const statusHint = computed(() => {
  if (broadcast.value) {
    const base = broadcast.value.isPlaying ? locale.value.liveTitle : locale.value.pausedTitle
    return listenerCount.value > 0
      ? `${base} · ${locale.value.listenerCount(listenerCount.value)}`
      : base
  }
  return canPublish.value ? t.value.readyHint : t.value.noPermissionHint
})

/** 服务端队列 → 本地草稿；服务端已带标题，拿不到时用 songId 兜住不空白 */
const toDraft = (items) =>
  (items || []).map((item) => ({
    songId: Number(item.songId),
    title: item.title || `#${item.songId}`,
    artist: item.artist || ''
  }))

const applyQueue = (items) => {
  draft.value = toDraft(items)
  savedKey.value = currentKey.value
}

const loadQueue = async () => {
  try {
    const data = await broadcastSync.refreshQueue()
    // 非基准播控人读不到服务端队列（403）时退回本地已有值，页面不因此变空
    applyQueue(data?.queue || broadcastSync.queue.value || [])
    autoAdvanceDraft.value = !!broadcastSync.autoAdvance?.value
  } catch (error) {
    console.error('读取播放单失败:', error)
    toast.error(t.value.loadFailed)
  }
}

const addToQueue = (song) => {
  const songId = Number(song.id)
  if (isInQueue(songId)) return
  draft.value.push({ songId, title: song.title || `#${songId}`, artist: song.artist || '' })
}

const removeItem = (index) => {
  draft.value.splice(index, 1)
}

const moveItem = (index, offset) => {
  const target = index + offset
  if (target < 0 || target >= draft.value.length) return
  const [moved] = draft.value.splice(index, 1)
  draft.value.splice(target, 0, moved)
}

const clearDraft = () => {
  draft.value = []
}

const playItem = (item) => {
  const song = library.value.find((entry) => Number(entry.id) === Number(item.songId))
  if (!song) {
    toast.error(t.value.notPlayable)
    return
  }
  // 播控端播放的上报由 AudioPlayer 自动完成，这里只负责让本机开始播
  void playSong(song)
}

const handleSave = async () => {
  if (saving.value) return
  saving.value = true
  try {
    await broadcastSync.saveQueue(draft.value.map((item) => Number(item.songId)))
    savedKey.value = currentKey.value
    toast.success(t.value.saved)
  } catch (error) {
    console.error('保存播放单失败:', error)
    toast.error(error?.data?.message || t.value.saveFailed)
  } finally {
    saving.value = false
  }
}

const handleAutoAdvanceChange = async () => {
  if (!canEditAuthority.value) return
  const next = autoAdvanceDraft.value
  try {
    await broadcastSync.saveAuthority({ autoAdvance: next })
  } catch (error) {
    // 保存失败就把开关拨回去，避免界面显示与服务器不一致
    autoAdvanceDraft.value = !next
    toast.error(error?.data?.message || locale.value.saveFailed)
  }
}

const enablePublish = () => {
  broadcastSync.setPublishEnabled(true)
}

const handlePlayNext = async () => {
  try {
    await broadcastSync.playNext()
  } catch (error) {
    toast.error(error?.data?.message || locale.value.advanceFailed)
  }
}

const handleStopBroadcast = () => {
  void broadcastSync.stopPublish()
}

onMounted(async () => {
  broadcastSync.connect()
  // 歌曲库与该页互不依赖，并行加载；任一失败不影响另一半可用
  await Promise.allSettled([songsStore.fetchSongs(true), loadQueue()])
})

onUnmounted(() => {
  broadcastSync.disconnect()
})
</script>

<style scoped>
.console {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

/* —— 顶部状态条 —— */
.status-bar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.85rem 1rem;
  border-radius: 14px;
  background: var(--overlay-8);
  border: 1px solid var(--overlay-15);
}

.status-bar.live {
  background: var(--color-accent-alpha-15);
  border-color: var(--color-accent-alpha-40);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--text-tertiary);
}

.status-dot.live {
  background: var(--color-accent);
  animation: console-pulse 1.6s ease-in-out infinite;
}

@keyframes console-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.4;
    transform: scale(0.8);
  }
}

.status-text {
  flex: 1;
  min-width: 0;
}

.status-title {
  font-size: 0.85rem;
  font-weight: 700;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-hint {
  margin-top: 0.15rem;
  font-size: 0.7rem;
  color: var(--text-tertiary);
}

.status-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
}

/* —— 两栏主体 —— */
.console-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 1rem;
}

@media (max-width: 1024px) {
  .console-body {
    grid-template-columns: minmax(0, 1fr);
  }
}

.panel {
  display: flex;
  flex-direction: column;
  min-height: 420px;
  max-height: 68vh;
  border-radius: 14px;
  border: 1px solid var(--border-secondary);
  background: var(--panel-bg-alt);
  overflow: hidden;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border-secondary);
}

.panel-title {
  font-size: 0.82rem;
  font-weight: 800;
  color: var(--text-primary);
}

.panel-meta {
  font-size: 0.7rem;
  color: var(--text-tertiary);
}

.panel-hint {
  padding: 0.5rem 1rem 0;
  font-size: 0.7rem;
  color: var(--text-tertiary);
}

.panel-search {
  padding: 0.65rem 1rem 0.35rem;
}

.search-input {
  width: 100%;
  padding: 0.5rem 0.7rem;
  border-radius: 10px;
  border: 1px solid var(--border-secondary);
  background: var(--panel-bg-deepest);
  color: var(--text-primary);
  font-size: 0.78rem;
  outline: none;
}

.search-input:focus {
  border-color: var(--color-accent);
}

.rows {
  flex: 1;
  overflow-y: auto;
  padding: 0.35rem 0.5rem 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.45rem 0.6rem;
  border-radius: 10px;
  border: 1px solid transparent;
  transition: background 0.15s ease;
}

.row:hover {
  background: var(--overlay-8);
}

.row.current {
  border-color: var(--color-accent-alpha-40);
  background: var(--color-accent-alpha-15);
}

.row.empty {
  justify-content: center;
  font-size: 0.72rem;
  color: var(--text-tertiary);
  padding: 1.2rem 0.6rem;
}

.row-index {
  width: 18px;
  flex-shrink: 0;
  text-align: center;
  font-size: 0.68rem;
  font-weight: 700;
  color: var(--text-tertiary);
}

.row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.row-title {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-sub {
  font-size: 0.68rem;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-badge {
  flex-shrink: 0;
  padding: 0 0.35rem;
  border-radius: 4px;
  font-size: 0.62rem;
  font-weight: 700;
  color: var(--color-accent);
  background: var(--color-accent-alpha-20);
}

.panel-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.7rem 1rem;
  border-top: 1px solid var(--border-secondary);
}

.switch {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.72rem;
  color: var(--text-secondary);
  cursor: pointer;
}

/* —— 按钮 —— */
.btn {
  padding: 0.4rem 0.8rem;
  border-radius: 10px;
  border: 1px solid var(--overlay-20);
  background: var(--overlay-10);
  color: var(--text-primary);
  font-size: 0.72rem;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
}

.btn:hover:not(:disabled) {
  background: var(--overlay-20);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn.accent {
  border-color: var(--color-accent-alpha-40);
  background: var(--color-accent-alpha-20);
  color: var(--color-accent);
}

.btn.tiny {
  padding: 0.3rem 0.6rem;
  font-size: 0.68rem;
}

.icon-btn {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  border: 1px solid var(--overlay-15);
  background: transparent;
  color: var(--text-secondary);
  font-size: 0.72rem;
  cursor: pointer;
  transition: all 0.15s ease;
}

.icon-btn:hover:not(:disabled) {
  background: var(--overlay-15);
  color: var(--text-primary);
}

.icon-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.link {
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 0.7rem;
  cursor: pointer;
}

.link:hover {
  color: var(--text-primary);
}
</style>
