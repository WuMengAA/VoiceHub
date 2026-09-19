<template>
  <!-- 无广播且本机无需控制时完全不占位 -->
  <div v-if="broadcast || showStaffRow" class="broadcast-bar-wrapper">
    <div v-if="broadcast" :class="{ paused: !broadcast.isPlaying }" class="broadcast-bar">
      <div class="broadcast-cover">
        <img
          v-if="broadcast.cover"
          :alt="broadcast.title"
          :src="convertToHttps(broadcast.cover)"
          loading="lazy"
          referrerpolicy="no-referrer"
        >
        <Icon v-else :size="20" name="music" />
      </div>

      <div class="broadcast-body">
        <div class="broadcast-status">
          <span class="status-dot" />
          <span class="status-text">{{ statusText }}</span>
          <span v-if="broadcast.publisherName" class="status-publisher">
            · {{ locale.publisher(broadcast.publisherName) }}
          </span>
          <span v-if="listenerCount > 0" class="status-listeners">
            · {{ locale.listenerCount(listenerCount) }}
          </span>
        </div>

        <div class="broadcast-title" :title="titleText">{{ titleText }}</div>

        <div v-if="broadcast.nextUp" class="broadcast-next">
          <span class="next-label">{{ locale.nextUp }}</span>
          <span class="next-title">{{ broadcast.nextUp.title }}</span>
          <span class="next-artist">{{ broadcast.nextUp.artist }}</span>
        </div>

        <div class="broadcast-progress">
          <div class="broadcast-progress-fill" :style="{ width: progressPercent }" />
        </div>

        <div class="broadcast-time">
          {{ formatTime(livePosition) }} / {{ formatTime(broadcast.duration) }}
        </div>
      </div>

      <div class="broadcast-actions">
        <button
          v-if="!canPublish"
          :class="{ active: followEnabled }"
          :title="locale.followHint"
          class="broadcast-btn follow"
          type="button"
          @click="toggleFollow"
        >
          <Icon :size="14" :name="followEnabled ? 'pause' : 'play'" />
          <span>{{ followEnabled ? locale.followOff : locale.followOn }}</span>
        </button>
        <button
          v-if="canPublish && broadcast.nextUp"
          :title="locale.playNext"
          class="broadcast-btn next"
          type="button"
          @click="handlePlayNext"
        >
          <Icon :size="14" name="skip-forward" />
          <span>{{ locale.playNext }}</span>
        </button>
        <button
          v-if="canPublish"
          class="broadcast-btn stop"
          type="button"
          @click="handleStopBroadcast"
        >
          <Icon :size="14" name="x" />
          <span>{{ locale.stopBroadcast }}</span>
        </button>
      </div>
    </div>

    <!-- 播控端操作条：没有广播时也显示，管理员可在这里指定基准播控人 -->
    <div v-if="showStaffRow" class="broadcast-control">
      <Icon :size="14" name="music" />
      <span class="control-text">{{ staffStatusText }}</span>
      <span class="control-hint">{{ staffHintText }}</span>
      <button
        v-if="canPublish && !publishEnabled"
        class="broadcast-btn start"
        type="button"
        @click="handleStartBroadcast"
      >
        {{ locale.startBroadcast }}
      </button>
      <button
        v-if="canTakeover"
        class="broadcast-btn takeover"
        type="button"
        @click="handleTakeover"
      >
        <Icon :size="14" name="repeat" />
        <span>{{ locale.takeover }}</span>
      </button>
      <button
        v-if="canPublish && baselineUserId"
        class="broadcast-btn release"
        type="button"
        @click="handleRelease"
      >
        <span>{{ locale.release }}</span>
      </button>
      <button
        v-if="canPublish"
        class="broadcast-btn queue"
        type="button"
        @click="queueOpen = true"
      >
        <Icon :size="14" name="list" />
        <span>{{ queueLabel }}</span>
      </button>
      <button
        v-if="canEditAuthority"
        class="broadcast-btn settings"
        type="button"
        @click="settingsOpen = true"
      >
        <Icon :size="14" name="settings" />
        <span>{{ locale.settings }}</span>
      </button>
    </div>

    <BroadcastSettingsModal :show="settingsOpen" @close="settingsOpen = false" />
    <BroadcastQueueModal :show="queueOpen" @close="queueOpen = false" />
  </div>
</template>

<script setup>
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref } from 'vue'
import Icon from '~/components/UI/Icon.vue'
import BroadcastSettingsModal from '~/components/Songs/BroadcastSettingsModal.vue'
// 播放单管理弹窗按需才开，懒加载减小首屏 JS
const BroadcastQueueModal = defineAsyncComponent(() => import('~/components/Songs/BroadcastQueueModal.vue'))
import { useToast } from '~/composables/useToast'
import { convertToHttps } from '~/utils/url'
import { useLocale } from '~/utils/locale'
import { useBroadcastSync } from '~/composables/useBroadcastSync'

const { songs: songsLocale } = useLocale()
const locale = computed(() => songsLocale.value?.broadcast || {})
const broadcastSync = useBroadcastSync()
const toast = useToast()

const broadcast = broadcastSync.broadcast
const followEnabled = broadcastSync.followEnabled
const livePosition = broadcastSync.livePosition
const progress = broadcastSync.progress
// 播控资格由服务端判定（角色基准 + 基准播控人 + 总开关），客户端不再用 isAdmin 自行推断
const canPublish = broadcastSync.canPublish
const canEditAuthority = broadcastSync.canEditAuthority
const authorityLoaded = broadcastSync.authorityLoaded
const authorityEnabled = broadcastSync.authorityEnabled
const baselineUser = broadcastSync.baselineUser
const denyReason = broadcastSync.denyReason
const publishEnabled = broadcastSync.publishEnabled
const canTakeover = broadcastSync.canTakeover
const takeoverDenyReason = broadcastSync.takeoverDenyReason
const listenerCount = broadcastSync.listenerCount
const queue = broadcastSync.queue

const settingsOpen = ref(false)
const queueOpen = ref(false)

/** 当前是否被指定了基准播控人（决定「交还播控权」按钮要不要出现） */
const baselineUserId = computed(
  () => broadcastSync.authorityConfig.value?.authority.effectiveBaselineUserId ?? null
)

const queueLabel = computed(() =>
  queue.value.length > 0 ? locale.value.queueTotal(queue.value.length) : locale.value.queueOpen
)

// 拿到服务端配置就说明当前登录者是歌曲管理员及以上，播控操作条对该角色始终可见：
// 命中基准时是「播控就绪」，未命中时说明「基准是谁」，避免管理员对着没反应的面板瞎猜
const showStaffRow = computed(() => authorityLoaded.value)

const staffStatusText = computed(() => {
  if (!authorityEnabled.value) return locale.value.staffDisabled
  if (!canPublish.value) {
    if (denyReason.value === 'NOT_BASELINE' && baselineUser.value) {
      return locale.value.baselineNotAllowed(baselineUser.value.name)
    }
    return locale.value.noPermission
  }
  return publishEnabled.value ? locale.value.staffReady : locale.value.publishingOff
})

const staffHintText = computed(() => {
  if (!authorityEnabled.value) return ''
  if (!canPublish.value) {
    return baselineUser.value
      ? locale.value.baselineUserHint(baselineUser.value.name)
      : locale.value.readOnlyHint
  }
  return publishEnabled.value ? locale.value.staffReadyHint : locale.value.publishingOffHint
})

const statusText = computed(() => {
  if (!broadcast.value) return ''
  return broadcast.value.isPlaying ? locale.value.liveTitle : locale.value.pausedTitle
})

const titleText = computed(() => {
  const current = broadcast.value
  if (!current) return ''
  const artist = current.artist ? ` - ${current.artist}` : ''
  return `${current.title || locale.value.unknownSong}${artist}`
})

const progressPercent = computed(() => `${Math.min(100, progress.value * 100).toFixed(2)}%`)

const formatTime = (seconds) => {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

const toggleFollow = () => {
  broadcastSync.setFollowEnabled(!followEnabled.value)
}

const takeoverBusy = computed(() => takeoverDenyReason.value === 'BASELINE_ACTIVE')

const handleStopBroadcast = () => {
  void broadcastSync.stopPublish()
}

const handleStartBroadcast = () => {
  broadcastSync.setPublishEnabled(true)
}

/** 手动切下一首：服务端会把权威状态推到播放单的下一首，播控端随后跟着播 */
const handlePlayNext = async () => {
  try {
    await broadcastSync.playNext()
  } catch (error) {
    toast.error(error?.data?.message || locale.value.advanceFailed)
  }
}

const handleTakeover = async () => {
  const target = baselineUser.value?.name || locale.value.noPermission
  const busy = takeoverBusy.value
  if (busy) {
    // 服务端已经判定对方还在播，直接把原因说清楚，不必再发一次注定失败的请求
    toast.error(locale.value.takeoverBusy(target))
    return
  }
  try {
    await broadcastSync.takeoverAuthority()
    toast.success(locale.value.takeoverDone)
  } catch (error) {
    toast.error(error?.data?.message || locale.value.takeoverFailed)
  }
}

const handleRelease = async () => {
  try {
    await broadcastSync.releaseAuthority()
    toast.success(locale.value.releaseDone)
  } catch (error) {
    toast.error(error?.data?.message || locale.value.releaseFailed)
  }
}

onMounted(() => {
  broadcastSync.connect()
})

onUnmounted(() => {
  broadcastSync.disconnect()
})
</script>

<style scoped>
.broadcast-bar-wrapper {
  margin-bottom: 1rem;
}

.broadcast-bar {
  display: flex;
  align-items: center;
  gap: 0.9rem;
  padding: 0.75rem 1rem;
  border-radius: 14px;
  background: var(--color-accent-alpha-15);
  border: 1px solid var(--color-accent-alpha-40);
  box-shadow: 0 4px 15px var(--mask-20);
}

.broadcast-bar.paused {
  background: var(--overlay-8);
  border-color: var(--overlay-20);
}

.broadcast-cover {
  width: 46px;
  height: 46px;
  flex-shrink: 0;
  border-radius: 10px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-subtle);
  color: var(--text-secondary);
}

.broadcast-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.broadcast-body {
  flex: 1;
  min-width: 0;
}

.broadcast-status {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.7rem;
  color: var(--text-secondary);
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-accent);
  animation: broadcast-pulse 1.6s ease-in-out infinite;
}

.broadcast-bar.paused .status-dot {
  animation: none;
  background: var(--text-secondary);
}

@keyframes broadcast-pulse {
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
  font-weight: 600;
  color: var(--color-accent);
}

.broadcast-bar.paused .status-text {
  color: var(--text-secondary);
}

.status-publisher {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-listeners {
  flex-shrink: 0;
}

.broadcast-next {
  display: flex;
  align-items: baseline;
  gap: 0.35rem;
  margin-top: 0.2rem;
  font-size: 0.68rem;
  color: var(--text-secondary);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.next-label {
  flex-shrink: 0;
  padding: 0 0.3rem;
  border-radius: 4px;
  background: var(--overlay-15);
  color: var(--text-secondary);
}

.next-title {
  font-weight: 600;
  color: var(--text-primary);
}

.broadcast-title {
  margin-top: 0.15rem;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.broadcast-progress {
  margin-top: 0.35rem;
  height: 3px;
  border-radius: 999px;
  background: var(--overlay-15);
  overflow: hidden;
}

.broadcast-progress-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--color-accent);
  transition: width 1s linear;
}

.broadcast-time {
  margin-top: 0.2rem;
  font-size: 0.65rem;
  color: var(--text-secondary);
}

.broadcast-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
}

.broadcast-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.4rem 0.8rem;
  border-radius: 999px;
  border: 1px solid var(--overlay-20);
  background: var(--overlay-10);
  color: var(--text-primary);
  font-size: 0.72rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
}

.broadcast-btn:hover {
  background: var(--overlay-20);
}

.broadcast-btn.follow.active {
  background: var(--color-accent-alpha-30);
  border-color: var(--color-accent-alpha-50);
  color: var(--color-accent);
}

.broadcast-btn.start {
  background: var(--color-accent-alpha-20);
  border-color: var(--color-accent-alpha-40);
  color: var(--color-accent);
}

.broadcast-btn.next {
  border-color: var(--color-accent-alpha-40);
  color: var(--color-accent);
}

.broadcast-btn.takeover {
  border-color: var(--overlay-30);
}

.broadcast-btn.settings {
  margin-left: auto;
}

.broadcast-control {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.9rem;
  border-radius: 12px;
  background: var(--overlay-8);
  border: 1px solid var(--overlay-15);
  color: var(--text-secondary);
  font-size: 0.72rem;
}

.control-text {
  font-weight: 600;
  color: var(--text-primary);
}

.control-hint {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 768px) {
  .broadcast-bar {
    flex-wrap: wrap;
  }

  .broadcast-actions {
    width: 100%;
    justify-content: flex-end;
  }

  .control-hint {
    display: none;
  }
}
</style>
