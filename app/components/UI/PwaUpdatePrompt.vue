<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-transform duration-500 ease-out"
      enter-from-class="translate-y-[100%]"
      enter-to-class="translate-y-0"
      leave-active-class="transition-transform duration-300 ease-in"
      leave-from-class="translate-y-0"
      leave-to-class="translate-y-[100%]"
    >
      <div
        v-if="needRefresh"
        class="fixed inset-x-0 bottom-0 z-[9000] shadow-2xl"
        role="status"
        aria-live="polite"
      >
        <div
          class="flex items-center gap-3 px-4 py-3 text-white sm:gap-4 sm:px-6 sm:py-3.5"
          style="background: linear-gradient(135deg, #f59e0b, #f97316)"
        >
          <div class="mt-0.5 shrink-0 text-xl leading-none sm:mt-0" aria-hidden="true">🔄</div>

          <div class="min-w-0 flex-1">
            <p class="text-sm font-black leading-tight drop-shadow-sm sm:text-base">
              有新版本可用
            </p>
            <p class="text-xs text-white/90">
              发现功能更新，点击「立即更新」以应用最新版本
            </p>
          </div>

          <button
            type="button"
            class="ml-2 shrink-0 rounded-lg bg-white/15 px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-white/25 focus:outline-none focus:ring-2 focus:ring-white/60"
            @click="update"
          >
            立即更新
          </button>
          <button
            type="button"
            class="shrink-0 rounded-lg px-2 py-1.5 text-xs font-medium text-white/80 transition-colors hover:text-white focus:outline-none"
            @click="dismiss"
          >
            稍后
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
const needRefresh = useState<boolean>('pwa-need-refresh', () => false)
const nuxtApp = useNuxtApp()

const update = () => {
  const fn = (nuxtApp as unknown as { $pwaUpdate?: () => void }).$pwaUpdate
  if (typeof fn === 'function') {
    fn()
  } else if (typeof window !== 'undefined') {
    window.location.reload()
  }
}

const dismiss = () => {
  needRefresh.value = false
}
</script>
