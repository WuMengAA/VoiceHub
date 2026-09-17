<template>
  <!-- 无广播且本机无需控制时完全不占位 -->
  <div v-if="broadcast || showPublishControl" class="broadcast-bar-wrapper">
    <div v-if="broadcast" :class="{ paused: !broadcast.isPlaying }" class="broadcast-bar">
      <div class="broadcast-cover">
        <img
          v-if="broadcast.cover"
          :alt="broadcast.title"
          :src="convertToHttps(broadcast.cover)"
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
        </div>

        <div class="broadcast-title" :title="titleText">{{ titleText }}</div>

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

    <!-- 播控端：广播同步被关闭时提供重新开启入口 -->
    <div v-if="showPublishControl" class="broadcast-control">
      <Icon :size="14" name="music" />
      <span class="control-text">{{ locale.publishingOff }}</span>
      <span class="control-hint">{{ locale.publishingOffHint }}</span>
      <button class="broadcast-btn start" type="button" @click="handleStartBroadcast">
        {{ locale.startBroadcast }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted } from 'vue'
import Icon from '~/components/UI/Icon.vue'
import { convertToHttps } from '~/utils/url'
import { useLocale } from '~/utils/locale'
import { useBroadcastSync } from '~/composables/useBroadcastSync'

const { songs: songsLocale } = useLocale()
const locale = computed(() => songsLocale.value?.broadcast || {})
const broadcastSync = useBroadcastSync()

const broadcast = broadcastSync.broadcast
const followEnabled = broadcastSync.followEnabled
const livePosition = broadcastSync.livePosition
const progress = broadcastSync.progress
const canPublish = broadcastSync.canPublish

// 播控端且已关闭同步时才显示重新开启入口，学生端不受影响
const showPublishControl = computed(
  () => canPublish.value && !broadcastSync.publishEnabled.value
)

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

const handleStopBroadcast = () => {
  void broadcastSync.stopPublish()
}

const handleStartBroadcast = () => {
  broadcastSync.setPublishEnabled(true)
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
