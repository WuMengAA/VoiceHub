<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-300 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition duration-200 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="show"
        class="queue-overlay fixed inset-0 z-[2000] bg-bg-primary-80 backdrop-blur-sm flex items-center justify-center p-4"
        @click="handleOverlayClick"
      >
        <div
          class="w-full max-w-xl max-h-[85vh] flex flex-col bg-bg-secondary border border-border-secondary rounded-3xl shadow-2xl overflow-hidden"
          @click.stop
        >
          <!-- 标题 -->
          <div class="flex items-start justify-between gap-4 p-6 border-b border-border-tertiary-50">
            <div>
              <h3 class="text-lg font-black text-text-primary tracking-tight">{{ locale.queueTitle }}</h3>
              <p class="mt-1 text-xs text-text-tertiary leading-relaxed">{{ locale.queueDesc }}</p>
            </div>
            <button
              class="shrink-0 w-8 h-8 rounded-xl flex items-center justify-center text-text-tertiary hover:bg-bg-tertiary transition-colors"
              type="button"
              @click="$emit('close')"
            >
              <Icon :size="16" name="x" />
            </button>
          </div>

          <!-- 内容 -->
          <div class="flex-1 overflow-y-auto p-6 space-y-5">
            <!-- 自动连播 -->
            <label class="flex items-start justify-between gap-4 cursor-pointer">
              <div>
                <p class="text-xs font-bold text-text-primary">{{ locale.autoAdvanceLabel }}</p>
                <p class="text-[10px] text-text-tertiary mt-0.5">{{ locale.autoAdvanceHint }}</p>
              </div>
              <input
                v-model="form.autoAdvance"
                :disabled="!canEditAuthority || saving"
                type="checkbox"
                class="mt-1 w-5 h-5 rounded border-border-secondary bg-bg-secondary cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                @change="handleAutoAdvanceChange"
              >
            </label>

            <!-- 已选播放单 -->
            <div class="space-y-2">
              <div class="flex items-center justify-between gap-2">
                <p class="text-xs font-bold text-text-primary">
                  {{ selectedSongs.length > 0 ? locale.queueTotal(selectedSongs.length) : locale.queueEmpty }}
                </p>
                <button
                  v-if="selectedSongs.length > 0"
                  class="text-[10px] text-text-tertiary hover:text-text-primary transition-colors"
                  type="button"
                  @click="clearSelection"
                >
                  {{ locale.queueClear }}
                </button>
              </div>

              <p v-if="selectedSongs.length === 0" class="text-[10px] text-text-tertiary">
                {{ locale.queueEmptyHint }}
              </p>

              <ul v-else class="space-y-1">
                <li
                  v-for="(item, index) in selectedSongs"
                  :key="`${item.songId}-${index}`"
                  class="flex items-center gap-2 px-3 py-2 rounded-xl border border-border-tertiary-50 bg-bg-tertiary-50"
                >
                  <span class="queue-index">{{ index + 1 }}</span>
                  <span class="min-w-0 flex-1">
                    <span class="block text-xs font-bold text-text-primary truncate">{{ item.songTitle }}</span>
                    <span class="block text-[10px] text-text-tertiary truncate">{{ item.songArtist }}</span>
                  </span>
                  <span
                    v-if="index === currentIndex"
                    class="shrink-0 text-[10px] font-bold text-color-accent"
                  >
                    {{ locale.queueCurrent }}
                  </span>
                  <button
                    class="shrink-0 w-6 h-6 rounded-lg flex items-center justify-center text-text-tertiary hover:bg-bg-quaternary transition-colors"
                    type="button"
                    @click="removeSong(index)"
                  >
                    <Icon :size="12" name="x" />
                  </button>
                </li>
              </ul>
            </div>

            <!-- 候选曲目：当日排期 -->
            <div class="space-y-2">
              <p class="text-xs font-bold text-text-primary">{{ candidateTitle }}</p>
              <div v-if="loading" class="text-[10px] text-text-tertiary">{{ locale.loading }}</div>
              <p v-else-if="candidates.length === 0" class="text-[10px] text-text-tertiary">
                {{ locale.queueEmptyHint }}
              </p>
              <ul v-else class="space-y-1 max-h-56 overflow-y-auto pr-1">
                <li v-for="item in candidates" :key="item.songId">
                  <button
                    type="button"
                    class="w-full flex items-center gap-2 px-3 py-2 rounded-xl border transition-colors text-left"
                    :class="
                      isSelected(item.songId)
                        ? 'border-primary-40 bg-primary-10'
                        : 'border-border-tertiary-50 hover:bg-bg-tertiary-50'
                    "
                    @click="toggleSong(item)"
                  >
                    <span class="checkbox-dot" :class="{ on: isSelected(item.songId) }" />
                    <span class="min-w-0 flex-1">
                      <span class="block text-xs font-bold text-text-primary truncate">{{ item.songTitle }}</span>
                      <span class="block text-[10px] text-text-tertiary truncate">{{ item.songArtist }}</span>
                    </span>
                  </button>
                </li>
              </ul>
            </div>
          </div>

          <!-- 操作 -->
          <div class="flex gap-3 p-6 pt-4 border-t border-border-tertiary-50">
            <button
              class="flex-1 px-6 py-3 bg-bg-tertiary hover:bg-bg-quaternary text-text-secondary text-xs font-black rounded-2xl transition-all uppercase tracking-widest"
              type="button"
              @click="$emit('close')"
            >
              {{ locale.cancel }}
            </button>
            <button
              class="flex-[2] px-6 py-3 bg-color-accent text-bg-primary text-xs font-black rounded-2xl shadow-lg transition-all active:scale-95 uppercase tracking-widest disabled:opacity-50 disabled:cursor-not-allowed"
              :disabled="saving"
              type="button"
              @click="handleSave"
            >
              {{ locale.save }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import Icon from '~/components/UI/Icon.vue'
import { useLocale } from '~/utils/locale'
import { useToast } from '~/composables/useToast'
import { useBroadcastSync } from '~/composables/useBroadcastSync'
import { useSongs } from '~/composables/useSongs'
import { getBeijingTimeISOString } from '~/utils/timeUtils'

const props = defineProps({
  show: { type: Boolean, default: false }
})
const emit = defineEmits(['close'])

const { songs: songsLocale } = useLocale()
const locale = computed(() => songsLocale.value?.broadcast || {})
const toast = useToast()
const broadcastSync = useBroadcastSync()
const songsStore = useSongs()

const canEditAuthority = broadcastSync.canEditAuthority
const autoAdvance = broadcastSync.autoAdvance

const saving = ref(false)
const loading = ref(false)
const selectedSongs = ref([])
const candidates = ref([])
const currentIndex = ref(-1)
const form = ref({ autoAdvance: false })

/** 播放单里的曲目不仅在排期里，还可能是临时插播，这里按 id 兜住 */
const findScheduleTitle = (songId) => {
  const hit = candidates.value.find((item) => item.songId === songId)
  return hit ? { title: hit.songTitle, artist: hit.songArtist } : { title: `#${songId}`, artist: '' }
}

/** 把服务端队列补成带标题的列表（服务端返回的队列本身就有标题，排期没拉取时也不至于空白） */
const hydrateQueue = (queue) =>
  (queue || []).map((item) => {
    const fallback = findScheduleTitle(item.songId)
    return {
      songId: item.songId,
      songTitle: item.title || fallback.title,
      songArtist: item.artist || fallback.artist
    }
  })

const isSelected = (songId) => selectedSongs.value.some((item) => item.songId === songId)

/** 候选来源的分组标题（当日排期） */
const candidateTitle = computed(() => locale.value.queueSource || locale.value.queueTitle)

const toggleSong = (item) => {
  const exists = selectedSongs.value.findIndex((entry) => entry.songId === item.songId)
  if (exists >= 0) {
    selectedSongs.value.splice(exists, 1)
    return
  }
  selectedSongs.value.push({ songId: item.songId, songTitle: item.songTitle, songArtist: item.songArtist })
}

const removeSong = (index) => {
  selectedSongs.value.splice(index, 1)
}

const clearSelection = () => {
  selectedSongs.value = []
}

/** 只取「今日排期」作为播放单候选：播放单按当日排期编排，不应混入其他日期的歌 */
const todaySchedules = (schedules) => {
  const todayStr = getBeijingTimeISOString().slice(0, 10)
  return (schedules || []).filter((s) => s.playDate === todayStr)
}

const loadCandidates = async () => {
  const schedules = todaySchedules(songsStore.publicSchedules?.value)
  const extract =
    schedules.length > 0
      ? songsStore.extractSongsFromSchedules(schedules)
      : null
  if (extract && extract.length > 0) {
    candidates.value = extract
      .map((song) => ({
        songId: Number(song.id),
        songTitle: song.title,
        songArtist: song.artist
      }))
      .filter((item) => Number.isInteger(item.songId) && item.songId > 0)
    return
  }

  loading.value = true
  try {
    await songsStore.fetchPublicSchedules()
    const list = songsStore.extractSongsFromSchedules(todaySchedules(songsStore.publicSchedules?.value || []))
    candidates.value = list
      .map((song) => ({
        songId: Number(song.id),
        songTitle: song.title,
        songArtist: song.artist
      }))
      .filter((item) => Number.isInteger(item.songId) && item.songId > 0)
  } catch (error) {
    console.error('读取当日排期失败:', error)
  } finally {
    loading.value = false
  }
}

/** 每次打开都重新对齐服务端的最新播放单，防止看到上一次的旧顺序 */
watch(
  () => props.show,
  async (visible) => {
    if (!visible) return
    form.value.autoAdvance = autoAdvance.value
    await loadCandidates()
    const data = await broadcastSync.refreshQueue()
    if (data) {
      selectedSongs.value = hydrateQueue(data.queue)
      currentIndex.value = Number(data.currentIndex ?? -1) || -1
      return
    }
    // 没有服务端数据时（比如非基准播控人）用本地已有队列兜底展示
    selectedSongs.value = hydrateQueue(broadcastSync.queue.value)
    currentIndex.value = Number(broadcastSync.queueCurrentIndex.value ?? -1) || -1
  },
  { immediate: true }
)

const handleAutoAdvanceChange = async () => {
  if (!canEditAuthority.value) return
  try {
    await broadcastSync.saveAuthority({ autoAdvance: form.value.autoAdvance })
  } catch (error) {
    form.value.autoAdvance = !form.value.autoAdvance
    toast.error(error?.data?.message || locale.value.saveFailed)
  }
}

const handleSave = async () => {
  if (saving.value) return
  saving.value = true
  try {
    const data = await broadcastSync.saveQueue(selectedSongs.value.map((item) => item.songId))
    selectedSongs.value = hydrateQueue(data?.queue)
    currentIndex.value = Number(data?.currentIndex ?? -1) || -1
    toast.success(locale.value.queueSaved)
    emit('close')
  } catch (error) {
    console.error('保存播放单失败:', error)
    toast.error(error?.data?.message || locale.value.queueSaveFailed)
  } finally {
    saving.value = false
  }
}

const handleOverlayClick = () => {
  emit('close')
}
</script>

<style scoped>
.queue-index {
  width: 18px;
  flex-shrink: 0;
  text-align: center;
  font-size: 10px;
  font-weight: 700;
  color: var(--text-tertiary);
}

.checkbox-dot {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  border-radius: 4px;
  border: 1px solid var(--border-secondary);
  background: var(--bg-secondary);
}

.checkbox-dot.on {
  border-color: var(--color-accent);
  background: var(--color-accent);
}

.queue-overlay :deep(.text-color-accent) {
  color: var(--color-accent);
}
</style>
