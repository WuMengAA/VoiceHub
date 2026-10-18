<template>
  <Teleport to="body">
    <Transition
      enter-active-class="install-app-enter-active"
      enter-from-class="install-app-enter-from"
      enter-to-class="install-app-enter-to"
      leave-active-class="install-app-leave-active"
      leave-from-class="install-app-leave-from"
      leave-to-class="install-app-leave-to"
    >
      <div v-if="visible" class="install-app" role="dialog" :aria-label="text.title">
        <div class="install-app__head">
          <span class="install-app__badge" aria-hidden="true">
            <Icon name="download" :size="18" />
          </span>

          <div class="install-app__body">
            <p class="install-app__title">{{ text.title }}</p>
            <p class="install-app__desc">{{ description }}</p>
            <p v-if="hint" class="install-app__hint">{{ hint }}</p>
          </div>

          <button type="button" class="install-app__close" :aria-label="text.gotIt" @click="dismiss">
            ×
          </button>
        </div>

        <div class="install-app__actions">
          <button
            v-if="mode === 'native'"
            type="button"
            class="install-app__btn install-app__btn--primary"
            @click="install"
          >
            {{ text.install }}
          </button>
          <button type="button" class="install-app__btn" @click="dismiss">
            {{ mode === 'native' ? text.later : text.gotIt }}
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useLocale } from '~/utils/locale'

// 关闭后 7 天内不再打扰
const DISMISS_KEY = 'voicehub-install-prompt-dismissed'
const DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000
// 延迟弹出，避开首屏渲染与版本更新横幅
const SHOW_DELAY_MS = 2500

const { installApp } = useLocale()
const { siteTitle } = useSiteConfig()

const visible = ref(false)
const mode = ref('native')
/** 由浏览器 beforeinstallprompt 事件给出的安装句柄 */
const deferredPrompt = ref(null)

const text = computed(() => installApp.value || {})

const description = computed(() => {
  const template = text.value.description
  if (typeof template !== 'string') return ''
  // {0} 为站点名称，取站内实时名称（后台改名后这里跟着变）
  return template.replace('{0}', siteTitle.value || '')
})

const hint = computed(() => {
  if (mode.value === 'ios') return text.value.iosHint || ''
  if (mode.value === 'manual') return text.value.manualHint || ''
  return ''
})

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  // iOS Safari 私有属性
  window.navigator.standalone === true

const isDismissedRecently = () => {
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY)
    if (!raw) return false
    const at = Number(raw)
    return Number.isFinite(at) && Date.now() - at < DISMISS_COOLDOWN_MS
  } catch {
    return false
  }
}

const isIosSafari = () => {
  const ua = window.navigator.userAgent
  const isIOSDevice =
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ 的 Safari 会把自己伪装成 macOS
    (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1)
  // 排除 iOS 上的 Chrome / Firefox / Edge，它们同样不能安装，但引导文案不同
  const isSafari = /^((?!chrome|android|crios|fxios|edgios).)*safari/i.test(ua)
  return isIOSDevice && isSafari
}

let showTimer = null

const handleBeforeInstallPrompt = (event) => {
  // 阻止浏览器自带的小提示条，改由本站弹窗统一引导（用户点「立即安装」才真正触发）
  event.preventDefault()
  deferredPrompt.value = event
  mode.value = 'native'
  schedule()
}

const handleInstalled = () => {
  // 安装完成：收起提示并记住，避免下次再弹
  persistDismiss()
  visible.value = false
}

const schedule = () => {
  if (showTimer) clearTimeout(showTimer)
  showTimer = setTimeout(() => {
    visible.value = true
  }, SHOW_DELAY_MS)
}

const persistDismiss = () => {
  try {
    window.localStorage.setItem(DISMISS_KEY, String(Date.now()))
  } catch {
    /* 隐私模式下 localStorage 不可写，忽略 */
  }
}

const install = async () => {
  const prompt = deferredPrompt.value
  if (!prompt) {
    visible.value = false
    return
  }
  // 每个事件句柄只能用一次，先置空防止重复调用
  deferredPrompt.value = null
  try {
    prompt.prompt()
    await prompt.userChoice
  } catch {
    /* 用户取消或浏览器拒绝，静默处理 */
  }
  persistDismiss()
  visible.value = false
}

const dismiss = () => {
  visible.value = false
  persistDismiss()
}

onMounted(() => {
  // 已经是独立应用（从主屏/桌面图标打开），无需再引导安装
  if (isStandalone() || isDismissedRecently()) return

  window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
  window.addEventListener('appinstalled', handleInstalled)

  // iOS Safari 不会触发 beforeinstallprompt，只能给「添加到主屏幕」的手动引导
  if (isIosSafari()) {
    mode.value = 'ios'
    schedule()
  }
})

onBeforeUnmount(() => {
  if (showTimer) clearTimeout(showTimer)
  window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
  window.removeEventListener('appinstalled', handleInstalled)
})
</script>

<style scoped>
.install-app {
  position: fixed;
  right: 1rem;
  bottom: 1rem;
  left: 1rem;
  z-index: 9100;
  max-width: 26rem;
  margin: 0 auto;
  padding: 0.9rem 1rem 0.75rem;
  border: 1px solid var(--border-color);
  border-radius: 0.9rem;
  background: var(--card-bg);
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.35);
}

@media (min-width: 640px) {
  .install-app {
    right: 1.5rem;
    bottom: 1.5rem;
    left: auto;
    margin: 0;
  }
}

.install-app__head {
  display: flex;
  align-items: flex-start;
  gap: 0.7rem;
}

.install-app__badge {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border-radius: 0.6rem;
  background: var(--primary-light);
  color: var(--primary);
}

.install-app__body {
  min-width: 0;
  flex: 1;
}

.install-app__title {
  margin: 0;
  color: var(--text-primary);
  font-size: 0.9rem;
  font-weight: 700;
  line-height: 1.3;
}

.install-app__desc {
  margin: 0.2rem 0 0;
  color: var(--text-secondary);
  font-size: 0.78rem;
  line-height: 1.45;
}

.install-app__hint {
  margin: 0.4rem 0 0;
  color: var(--text-tertiary);
  font-size: 0.74rem;
  line-height: 1.45;
}

.install-app__close {
  flex-shrink: 0;
  padding: 0 0.25rem;
  border: 0;
  background: none;
  color: var(--text-tertiary);
  font-size: 1.1rem;
  line-height: 1;
  cursor: pointer;
}

.install-app__close:hover {
  color: var(--text-primary);
}

.install-app__actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.7rem;
}

.install-app__btn {
  padding: 0.35rem 0.85rem;
  border: 1px solid var(--border-color);
  border-radius: 0.5rem;
  background: transparent;
  color: var(--text-secondary);
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  transition:
    background-color 0.2s ease,
    color 0.2s ease;
}

.install-app__btn:hover {
  color: var(--text-primary);
}

.install-app__btn--primary {
  border-color: transparent;
  background: var(--primary);
  color: #fff;
}

.install-app__btn--primary:hover {
  background: var(--primary-hover);
  color: #fff;
}

.install-app-enter-active,
.install-app-leave-active {
  transition:
    transform 0.32s ease,
    opacity 0.32s ease;
}

.install-app-enter-from,
.install-app-leave-to {
  opacity: 0;
  transform: translateY(120%);
}
</style>
