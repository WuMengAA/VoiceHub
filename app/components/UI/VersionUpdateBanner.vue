<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-transform duration-500 ease-out"
      enter-from-class="translate-y-[-100%]"
      enter-to-class="translate-y-0"
      leave-active-class="transition-transform duration-300 ease-in"
      leave-from-class="translate-y-0"
      leave-to-class="translate-y-[-100%]"
    >
      <div
        v-if="visible"
        class="fixed inset-x-0 top-0 z-[9000] shadow-2xl"
        role="status"
        aria-live="polite"
      >
        <div
          class="flex items-start gap-3 px-4 py-3 text-white sm:items-center sm:gap-4 sm:px-6 sm:py-3.5"
          style="background: linear-gradient(135deg, var(--primary, #3b82f6), #8b5cf6)"
        >
          <div class="mt-0.5 shrink-0 text-xl leading-none sm:mt-0" aria-hidden="true">🎧</div>

          <div class="min-w-0 flex-1">
            <p class="text-sm font-black leading-tight drop-shadow-sm sm:text-base">
              ✨ 新版本 v{{ version }} 已上线
            </p>
            <ul class="mt-1 space-y-0.5 text-xs text-white/90">
              <li v-for="(item, i) in highlights" :key="i" class="flex gap-1.5">
                <span aria-hidden="true">·</span>
                <span class="min-w-0">{{ item }}</span>
              </li>
            </ul>
          </div>

          <button
            type="button"
            class="ml-2 shrink-0 rounded-lg bg-white/15 px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-white/25 focus:outline-none focus:ring-2 focus:ring-white/60"
            @click="dismiss"
          >
            知道了
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRuntimeConfig } from '#imports'

// 每次发版在此更新亮点文案（面向最终用户，简要列出本版主要改进）
const highlights = [
  '「运动会」联动更新',
  '播放器主题「音域回响」上线',
  '「一起听」功能上线',
  '修复了一些已知 bug',
  '内核版本更新至 1.6.0.0'
]

const STORAGE_KEY = 'voicehub-seen-version'
const config = useRuntimeConfig()
const version = ref('')
const visible = ref(false)

onMounted(() => {
  const appVersion = config.public.appVersion || ''
  if (!appVersion) return

  let seen = ''
  try {
    seen = localStorage.getItem(STORAGE_KEY) || ''
  } catch {
    seen = ''
  }

  if (seen !== appVersion) {
    version.value = appVersion
    requestAnimationFrame(() => {
      visible.value = true
    })
  }
})

const dismiss = () => {
  try {
    localStorage.setItem(STORAGE_KEY, version.value)
  } catch {
    /* 忽略写入失败（如隐私模式） */
  }
  visible.value = false
}
</script>
