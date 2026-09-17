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
        class="fixed inset-0 z-[2000] bg-bg-primary-80 backdrop-blur-sm flex items-center justify-center p-4"
        @click="handleOverlayClick"
      >
        <div
          class="w-full max-w-lg max-h-[85vh] flex flex-col bg-bg-secondary border border-border-secondary rounded-3xl shadow-2xl overflow-hidden"
          @click.stop
        >
          <!-- 标题 -->
          <div class="flex items-start justify-between gap-4 p-6 border-b border-border-tertiary-50">
            <div>
              <h3 class="text-lg font-black text-text-primary tracking-tight">{{ locale.settingsTitle }}</h3>
              <p class="mt-1 text-xs text-text-tertiary leading-relaxed">{{ locale.settingsDesc }}</p>
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
            <div v-if="!authorityLoaded" class="text-sm text-text-tertiary">{{ locale.loading }}</div>

            <template v-else>
              <!-- 总开关 -->
              <label class="flex items-start justify-between gap-4 cursor-pointer">
                <div>
                  <p class="text-xs font-bold text-text-primary">{{ locale.enabledLabel }}</p>
                  <p class="text-[10px] text-text-tertiary mt-0.5">{{ locale.enabledHint }}</p>
                </div>
                <input
                  v-model="form.enabled"
                  :disabled="!canEdit"
                  type="checkbox"
                  class="mt-1 w-5 h-5 rounded border-border-secondary bg-bg-secondary cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
              </label>

              <!-- 基准播控人 -->
              <div class="space-y-2">
                <p class="text-xs font-bold text-text-primary">{{ locale.baselineLabel }}</p>

                <div
                  v-if="authority.baselineUserStale"
                  class="rounded-xl border border-warning-40 bg-warning-15 p-3 text-[10px] leading-relaxed text-text-secondary"
                >
                  {{ locale.baselineStale }}
                </div>

                <button
                  type="button"
                  class="w-full flex items-center gap-3 text-left px-3 py-2.5 rounded-xl border transition-colors disabled:cursor-not-allowed"
                  :class="selectedClass(form.baselineUserId === null)"
                  :disabled="!canEdit"
                  @click="form.baselineUserId = null"
                >
                  <span class="radio-dot" :class="{ on: form.baselineUserId === null }" />
                  <span class="min-w-0">
                    <span class="block text-xs font-bold text-text-primary">{{ locale.baselineRoleOnly }}</span>
                    <span class="block text-[10px] text-text-tertiary mt-0.5">{{ locale.baselineRoleOnlyHint }}</span>
                  </span>
                </button>

                <button
                  v-for="candidate in candidates"
                  :key="candidate.id"
                  type="button"
                  class="w-full flex items-center gap-3 text-left px-3 py-2.5 rounded-xl border transition-colors disabled:cursor-not-allowed"
                  :class="selectedClass(form.baselineUserId === candidate.id)"
                  :disabled="!canEdit"
                  @click="form.baselineUserId = candidate.id"
                >
                  <span class="radio-dot" :class="{ on: form.baselineUserId === candidate.id }" />
                  <span class="min-w-0 flex-1">
                    <span class="block text-xs font-bold text-text-primary truncate">
                      {{ candidate.name }}
                      <span class="ml-1 text-[10px] font-normal text-text-tertiary">{{ roleLabel(candidate.role) }}</span>
                    </span>
                    <span class="block text-[10px] text-text-tertiary mt-0.5 truncate">
                      {{ candidateMeta(candidate) }}
                    </span>
                  </span>
                </button>

                <p v-if="candidates.length === 0" class="text-[10px] text-text-tertiary">
                  {{ locale.readOnlyHint }}
                </p>
              </div>
            </template>
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
              class="flex-[2] px-6 py-3 text-text-primary text-xs font-black rounded-2xl shadow-lg transition-all active:scale-95 uppercase tracking-widest disabled:opacity-50 disabled:cursor-not-allowed"
              :disabled="!canEdit || saving"
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
import { computed, reactive, watch } from 'vue'
import Icon from '~/components/UI/Icon.vue'
import { useLocale } from '~/utils/locale'
import { useToast } from '~/composables/useToast'
import { useBroadcastSync } from '~/composables/useBroadcastSync'

const props = defineProps({
  show: { type: Boolean, default: false }
})
const emit = defineEmits(['close'])

const { currentLocale, songs: songsLocale } = useLocale()
const locale = computed(() => songsLocale.value?.broadcast || {})
const toast = useToast()
const broadcastSync = useBroadcastSync()

const authorityLoaded = broadcastSync.authorityLoaded
const canEdit = broadcastSync.canEditAuthority
const authority = computed(() => broadcastSync.authorityConfig.value?.authority || {})
const candidates = computed(() => broadcastSync.authorityConfig.value?.candidates || [])

const saving = ref(false)
const form = reactive({
  enabled: true,
  baselineUserId: null
})

// 每次打开都从服务端最新配置回填，避免看到上次打开时的旧值
watch(
  () => props.show,
  (visible) => {
    if (!visible) return
    void broadcastSync.refreshAuthority().then((data) => {
      if (!data) return
      form.enabled = data.authority.enabled !== false
      form.baselineUserId = data.authority.baselineUserId ?? null
    })
  },
  { immediate: true }
)

const roleLabels = computed(() =>
  currentLocale.value === 'en-US'
    ? { SONG_ADMIN: 'Song admin', ADMIN: 'Admin', SUPER_ADMIN: 'Super admin' }
    : { SONG_ADMIN: '歌曲管理员', ADMIN: '管理员', SUPER_ADMIN: '超级管理员' }
)

const roleLabel = (role) => roleLabels.value[role] || role

const candidateMeta = (candidate) => {
  const parts = [candidate.username]
  const klass = [candidate.grade, candidate.class].filter(Boolean).join(' ')
  if (klass) parts.push(klass)
  return parts.join(' · ')
}

const selectedClass = (selected) => [
  selected
    ? 'border-primary-40 bg-primary-10'
    : 'border-border-tertiary-50 hover:bg-bg-tertiary-50'
]

const handleOverlayClick = () => {
  emit('close')
}

const handleSave = async () => {
  if (!canEdit.value || saving.value) return
  saving.value = true
  try {
    await broadcastSync.saveAuthority({
      enabled: form.enabled,
      baselineUserId: form.baselineUserId
    })
    toast.success(locale.value.saveSuccess)
    emit('close')
  } catch (error) {
    console.error('保存播控设置失败:', error)
    toast.error(error?.data?.message || locale.value.saveFailed)
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.radio-dot {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  border-radius: 50%;
  border: 1px solid var(--border-secondary);
  background: var(--bg-secondary);
}

.radio-dot.on {
  border-color: var(--color-accent);
  background: var(--color-accent);
  box-shadow: inset 0 0 0 3px var(--bg-secondary);
}
</style>
