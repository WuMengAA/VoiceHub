// PWA 更新注册（prompt 模式）
// 检测到新版本时不再自动整页 reload（autoUpdate 会导致发版后所有用户首访白屏刷新两次），
// 而是把 needRefresh 状态置 true，由 PwaUpdatePrompt.vue 弹底部提示，用户主动点「立即更新」才 reload。
// nuxt.config 中 injectRegister 已设为 null，故在此手动调用 registerSW。
// @ts-ignore virtual:pwa-register 由 @vite-pwa/nuxt 在构建期注入
import { registerSW } from 'virtual:pwa-register'
import { defineNuxtPlugin, useState } from '#imports'

export default defineNuxtPlugin((nuxtApp) => {
  if (import.meta.server) return

  const needRefresh = useState<boolean>('pwa-need-refresh', () => false)
  const offlineReady = useState<boolean>('pwa-offline-ready', () => false)

  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      needRefresh.value = true
    },
    onOfflineReady() {
      offlineReady.value = true
    }
  })

  // 用户点「立即更新」时调用，传 true 触发 skipWaiting + 整页 reload 应用新版本
  nuxtApp.provide('pwaUpdate', () => updateSW(true))
})
