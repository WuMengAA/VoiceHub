import { useLocale } from '~/utils/locale'

export const AGGREGATE_OAUTH_LOGIN_TYPE_OPTIONS = [
  { value: 'qq', label: 'QQ' },
  { value: 'wx', label: 'WeChat' },
  { value: 'alipay', label: 'Alipay' },
  { value: 'sina', label: 'Weibo' },
  { value: 'baidu', label: 'Baidu' },
  { value: 'douyin', label: 'Douyin' },
  { value: 'huawei', label: 'Huawei' },
  { value: 'xiaomi', label: 'Xiaomi' },
  { value: 'gitee', label: 'Gitee' },
  { value: 'gitea', label: 'Gitea' },
  { value: 'bilibili', label: 'Bilibili' },
  { value: 'kuaishou', label: 'Kuaishou' }
] as const

const AGGREGATE_OAUTH_LOGIN_TYPE_ICONS: Record<string, string> = {
  qq: 'oauth-qq',
  wx: 'oauth-wechat',
  alipay: 'oauth-alipay',
  sina: 'oauth-sina-weibo',
  baidu: 'oauth-baidu',
  douyin: 'oauth-douyin',
  huawei: 'oauth-huawei',
  xiaomi: 'oauth-xiaomi',
  gitee: 'oauth-gitee',
  gitea: 'oauth-gitea',
  bilibili: 'oauth-bilibili',
  kuaishou: 'oauth-kuaishou'
}

export const normalizeAggregateOAuthLoginTypes = (value: unknown): string[] => {
  let values: unknown[] = []

  if (Array.isArray(value)) {
    values = value
  } else if (typeof value === 'string' && value.trim()) {
    const normalized = value.trim()
    try {
      const parsed = JSON.parse(normalized)
      values = Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      values = normalized.split(',')
    }
  }

  const supported = new Set<string>(AGGREGATE_OAUTH_LOGIN_TYPE_OPTIONS.map((item) => item.value))
  return [
    ...new Set(
      values
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().toLowerCase())
        .filter((item) => supported.has(item))
    )
  ]
}

export const getAggregateOAuthLoginTypesOrDefault = (value: unknown): string[] => {
  const normalized = normalizeAggregateOAuthLoginTypes(value)
  const hasConfiguredValue =
    (Array.isArray(value) && value.length > 0) ||
    (typeof value === 'string' && value.trim().length > 0)
  return normalized.length > 0 || hasConfiguredValue ? normalized : ['qq']
}

export const getAggregateOAuthLoginTypeName = (loginType: string): string => {
  const { auth } = useLocale()
  const localizedName = auth.value?.oauthButtons?.aggregateLoginTypes?.[loginType]
  return (
    localizedName ||
    AGGREGATE_OAUTH_LOGIN_TYPE_OPTIONS.find((item) => item.value === loginType)?.label ||
    loginType.toUpperCase()
  )
}

export const getAggregateOAuthLoginTypeIcon = (loginType: string): string => {
  return AGGREGATE_OAUTH_LOGIN_TYPE_ICONS[loginType] || 'user'
}

/**
 * 「第三方 OAuth2」登录按钮的图标（自定义授权服务器，当前是星璃）。
 *
 * 背景：OAuthButtons.vue 里的图标分支是按 provider.key 写死的 —— github / casdoor / google
 * 各有专属组件，routeProvider === 'aggregate' 走上面的 loginType 映射表，其余一律落到
 * lucide 的 <Shield> 盾牌。provider 对象（见 useSiteConfig.js）只有 key / name 两个字段，
 * **没有 icon 或 logo 配置项**，所以后台填什么都改不了图标。
 *
 * 于是走「图标由授权服务器托管」的路子：URL 写在这里，SVG 本体放在对方站点上
 *（Stelarith 的 static/oauth/stelarith.svg）。好处是换图标只改对方站点上的 SVG，
 * 不必再动一次前端；代价是 URL 在前端是常量，对方站点域名变了要改这里。
 *
 * key 是当前唯一可用的判别式：自定义 OAuth2 那一项固定为 'oauth2'
 * （useSiteConfig.js 里 providers.push({ key: 'oauth2', name: ... })）。
 * 将来若接入第二家自定义授权服务器，在这里按 key 增行并加一条分支即可。
 */
const EXTERNAL_OAUTH_ICON_URLS: Record<string, string> = {
  oauth2: 'https://www.245959623.xyz/oauth/stelarith.svg'
}

export const getExternalOAuthIconUrl = (
  provider: { key?: string; routeProvider?: string } | null | undefined
): string | null => {
  const key = provider?.key ?? ''
  if (!key) return null
  return EXTERNAL_OAUTH_ICON_URLS[key] ?? EXTERNAL_OAUTH_ICON_URLS[provider?.routeProvider ?? ''] ?? null
}

export const getProviderDisplayName = (provider: string): string => {
  const { auth } = useLocale()
  const normalizedProvider = provider.toLowerCase()
  if (normalizedProvider.startsWith('aggregate:')) {
    const loginType = normalizedProvider.slice('aggregate:'.length)
    const providerName = getAggregateOAuthLoginTypeName(loginType)
    const formatter = auth.value?.oauthButtons?.aggregateProviderName
    return typeof formatter === 'function' ? formatter(providerName) : `${providerName} 登录`
  }

  const map: Record<string, string> = {
    github: 'GitHub',
    casdoor: 'Casdoor',
    google: 'Google',
    oauth2: auth.value?.oauthButtons?.customOAuthProvider || '第三方 OAuth',
    aggregate: auth.value?.oauthButtons?.aggregateOAuthProvider || '聚合登录'
  }
  return map[normalizedProvider] || provider.charAt(0).toUpperCase() + provider.slice(1)
}

export const getOAuthProviderName = (provider: string): string => {
  const normalizedProvider = String(provider || '').trim().toLowerCase()
  if (normalizedProvider.startsWith('aggregate:')) {
    return getAggregateOAuthLoginTypeName(normalizedProvider.slice('aggregate:'.length))
  }
  return getProviderDisplayName(normalizedProvider)
}
