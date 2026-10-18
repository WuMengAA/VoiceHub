import { computed, onServerPrefetch } from 'vue'
import { useHead, useRequestFetch, useRequestURL, useRuntimeConfig, useState } from '#imports'

/**
 * 把站点信息在 SSR 阶段就写进 HTML head。
 *
 * 背景：<title> / OG 标签此前用的是构建期常量，而站内标题来自数据库（/api/site-config），
 * 于是站外（搜索引擎爬虫、微信/QQ 分享卡片、浏览器标签页）看到的永远是构建时的默认名，
 * 只有用户真正进站、客户端拉到配置之后才会刷新。
 * 这里在服务端渲染前把配置读出来写进 head，让站外与站内一致。
 *
 * @returns {void}
 */
export const useSiteMeta = () => {
  const config = useRuntimeConfig()
  const requestUrl = useRequestURL()

  const fallbackTitle = config.public.siteTitle || '星璃校园广播'
  const fallbackDescription = config.public.siteDescription || ''
  const ogImage = config.public.ogImage || '/og-image.png'

  // 分享缩略图必须是外部可直接抓取的绝对 URL：微信/QQ 等平台拿到相对路径会直接放弃缩略图。
  // 未配置 NUXT_PUBLIC_HOST 时用当前请求的域名兜底，避免线上出现相对路径。
  const absoluteOgImage = computed(() => {
    if (/^(https?:)?\/\//i.test(ogImage)) return ogImage
    const base = `${requestUrl.protocol}//${requestUrl.host}`
    return `${base}${ogImage.startsWith('/') ? '' : '/'}${ogImage}`
  })

  // 站点配置：服务端取一次写入 payload，客户端 hydrate 时直接复用，不重复请求。
  const siteSettings = useState('site-meta-config', () => null)
  // useRequestFetch 会带上当前请求上下文，相对路径的 /api 调用在服务端才可用
  const requestFetch = useRequestFetch()

  onServerPrefetch(async () => {
    if (siteSettings.value) return
    try {
      siteSettings.value = await requestFetch('/api/site-config', { timeout: 3000 })
    } catch {
      // 数据库未就绪 / 接口异常：保持 null 并回退到构建期默认值。
      // 站点配置不是首屏关键数据，这里刻意吞掉异常，不让它影响页面渲染或变成 500
    }
  })

  const pick = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '')

  const siteTitle = computed(
    () => pick(siteSettings.value && siteSettings.value.siteTitle) || fallbackTitle
  )
  const siteDescription = computed(
    () => pick(siteSettings.value && siteSettings.value.siteDescription) || fallbackDescription
  )

  useHead(() => ({
    title: siteTitle.value,
    meta: [
      { name: 'description', content: siteDescription.value },
      // Open Graph：分享到微信/QQ/微博/Telegram 等平台时读取的标题与缩略图
      { property: 'og:url', content: requestUrl.href },
      { property: 'og:title', content: siteTitle.value },
      { property: 'og:description', content: siteDescription.value },
      { property: 'og:site_name', content: siteTitle.value },
      { property: 'og:image', content: absoluteOgImage.value },
      // secure_url 同样必须是绝对 URL（构建期未配置 NUXT_PUBLIC_HOST 时是相对路径），
      // 部分平台优先读它，留着相对值等于白白丢掉缩略图
      { property: 'og:image:secure_url', content: absoluteOgImage.value },
      { name: 'twitter:title', content: siteTitle.value },
      { name: 'twitter:description', content: siteDescription.value },
      { name: 'twitter:image', content: absoluteOgImage.value },
      // iOS 添加到主屏时显示的名称，与站内名称保持一致
      { name: 'apple-mobile-web-app-title', content: siteTitle.value }
    ]
  }))
}
