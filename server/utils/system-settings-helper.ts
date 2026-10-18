import { db } from '~/drizzle/db'
import { systemSettings } from '~/drizzle/schema'
import type { SystemSettings } from '~/drizzle/schema'

// 进程内轻量缓存：广播轮询 / SSE 心跳每个 tick 都会读系统设置，
// 直接打到 DB 是最大的无谓开销。这里用 5s TTL 的内存缓存兜底，
// 写入侧（admin 设置接口）通过 invalidateSystemSettingsCache() 主动失效。
interface CachedSettings {
  value: SystemSettings | null
  at: number
}
let _settingsCache: CachedSettings | null = null
const SETTINGS_CACHE_TTL_MS = 5000

export function invalidateSystemSettingsCache(): void {
  _settingsCache = null
}

/**
 * 统一读取系统设置，读取失败时返回 null，由调用方按安全默认值降级。
 * 说明：随主分支 minimize-Redis 重构，此处直接查询数据库，不再经过缓存层。
 *       额外加一层进程内短 TTL 缓存，避免高频读把 DB 打满（服务端 CPU/内存优化）。
 */
export async function getSystemSettingsCached(): Promise<SystemSettings | null> {
  const now = Date.now()
  if (_settingsCache && now - _settingsCache.at < SETTINGS_CACHE_TTL_MS) {
    return _settingsCache.value
  }
  try {
    const [settings] = await db.select().from(systemSettings).limit(1)
    _settingsCache = { value: settings ?? null, at: now }
    return settings ?? null
  } catch (error) {
    console.warn('[SystemSettings] 读取系统设置失败:', error)
    // 读库失败时降级用旧缓存，避免雪崩（缓存为空才返回 null）
    if (_settingsCache) return _settingsCache.value
    return null
  }
}

export async function getForcePasswordChangeOnFirstLogin(): Promise<boolean> {
  const settings = await getSystemSettingsCached()
  return settings && typeof settings.forcePasswordChangeOnFirstLogin === 'boolean'
    ? settings.forcePasswordChangeOnFirstLogin
    : false
}

export function computeRequirePasswordChange(
  user: { forcePasswordChange?: boolean | null; passwordChangedAt?: Date | string | null },
  forcePasswordChangeOnFirstLogin: boolean
): boolean {
  return !!user.forcePasswordChange || (forcePasswordChangeOnFirstLogin && !user.passwordChangedAt)
}

export async function resolveRequirePasswordChange(user: {
  forcePasswordChange?: boolean | null
  passwordChangedAt?: Date | string | null
}): Promise<boolean> {
  if (user.forcePasswordChange) return true
  if (user.passwordChangedAt) return false
  return computeRequirePasswordChange(user, await getForcePasswordChangeOnFirstLogin())
}
