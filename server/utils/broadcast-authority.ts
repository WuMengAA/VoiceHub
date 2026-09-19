import type { H3Event } from 'h3'
import { db, users } from '~/drizzle/db'
import { systemSettings } from '~/drizzle/schema'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { createApiError } from '~~/server/utils/apiError'
import { SERVER_ERROR_CODES } from '~~/server/config/constants'
import { getSystemSettingsCached } from '~~/server/utils/system-settings-helper'
import { SYSTEM_SETTINGS_DEFAULTS } from '~~/server/utils/system-settings-defaults'
import { getServerTimestamp } from './serverTime.ts'

/**
 * 基准播控角色：校园广播的「正在播放」由歌曲管理员起步的角色对外播报。
 * 这与 requireSongAdmin 保持一致——权限只放宽到不能再宽，收紧则靠基准用户。
 */
export const BROADCAST_BASELINE_ROLES = ['SONG_ADMIN', 'ADMIN', 'SUPER_ADMIN'] as const

/**
 * 接管保护窗口：广播进行中，且基准人在这个窗口内还发过播控心跳时，别人不许抢。
 * 比自动释放阈值（默认 180s）短很多——「人还在按播放」的保护要更灵敏。
 */
const BROADCAST_BASELINE_ACTIVE_MS = 45_000

/** 可被选为基准播控人的用户（用于后台下拉框） */
export interface BroadcastCandidateUser {
  id: number
  name: string
  username: string
  role: string
  grade: string | null
  class: string | null
}

/**
 * 当前生效的播控基准
 */
export interface BroadcastAuthority {
  /** 总开关：关闭后无人可播控，学生端也不显示「正在播放」 */
  enabled: boolean
  /** 设置里指定的基准播控人 ID（可能是失效的，见 stale） */
  baselineUserId: number | null
  /** 实际生效的基准播控人；为空表示按「基准角色」放开 */
  effectiveBaselineUserId: number | null
  /** 生效基准播控人的展示信息 */
  baselineUser: BroadcastCandidateUser | null
  /** 指定的基准用户已失效（被删除 / 禁用 / 降权），此时自动降级回角色基准 */
  baselineUserStale: boolean
  /** 基准角色列表 */
  roles: readonly string[]
  /** 基准人最后一次播控心跳的服务器时间戳；从未播控时为 null */
  baselineLastActiveAt: number | null
  /** 自动释放基准锁的空闲阈值（秒）；0 表示不自动释放 */
  idleReleaseSec: number
  /** 是否开启自动连播（播完自动切播放单里的下一首） */
  autoAdvance: boolean
  /** 是否统计并对外下发在线收听人数 */
  listenersEnabled: boolean
}

/** 播控心跳记录：谁在什么时候动过播控 */
const lastBroadcastActivity = new Map<number, number>()

export function markBroadcastActivity(userId: number, at: number = getServerTimestamp()): void {
  if (!Number.isFinite(userId) || userId <= 0) return
  lastBroadcastActivity.set(userId, at)
  if (lastBroadcastActivity.size > 200) {
    // 只保留最近活跃的一部分，避免长期运行后无限增长
    const sorted = [...lastBroadcastActivity.entries()].sort((a, b) => b[1] - a[1])
    lastBroadcastActivity.clear()
    sorted.slice(0, 100).forEach(([id, time]) => lastBroadcastActivity.set(id, time))
  }
}

export function getBroadcastLastActiveAt(userId: number | null | undefined): number | null {
  if (!userId) return null
  return lastBroadcastActivity.get(userId) ?? null
}

const toPositiveInt = (value: unknown, fallback: number): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback
}

const toCandidateUser = (row: {
  id: number
  name: string | null
  username: string
  role: string
  grade: string | null
  class: string | null
}): BroadcastCandidateUser => ({
  id: Number(row.id),
  name: row.name || row.username,
  username: row.username,
  role: row.role,
  grade: row.grade ?? null,
  class: row.class ?? null
})

/**
 * 列出可被指定为基准播控人的用户。
 * 只取角色在基准范围内且账号正常的用户——把「已禁用」「已降权」的人列出来只会让管理员白选。
 */
export async function listBroadcastCandidates(): Promise<BroadcastCandidateUser[]> {
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      username: users.username,
      role: users.role,
      grade: users.grade,
      class: users.class
    })
    .from(users)
    .where(and(inArray(users.role, [...BROADCAST_BASELINE_ROLES]), eq(users.status, 'active')))
    .orderBy(asc(users.role), asc(users.name), asc(users.id))

  return rows.map(toCandidateUser)
}

/**
 * 解析当前播控基准。
 *
 * 规则：
 * - 未指定基准用户 → 基准为「歌曲管理员及以上」角色，任一该角色用户均可播控；
 * - 已指定基准用户 → 仅该用户可播控；
 * - 指定的人被删除 / 禁用 / 降权时不算数，自动降级回角色基准，避免播控被彻底锁死。
 */
export async function resolveBroadcastAuthority(): Promise<BroadcastAuthority> {
  const settings = await getSystemSettingsCached()
  const enabled = settings ? settings.broadcastEnabled !== false : true
  const rawBaselineId = settings?.broadcastBaselineUserId ?? null
  const baselineUserId = rawBaselineId === null ? null : Number(rawBaselineId)

  if (baselineUserId === null || !Number.isInteger(baselineUserId) || baselineUserId <= 0) {
    return {
      enabled,
      baselineUserId: null,
      effectiveBaselineUserId: null,
      baselineUser: null,
      baselineUserStale: false,
      roles: BROADCAST_BASELINE_ROLES,
      baselineLastActiveAt: null,
      idleReleaseSec: toPositiveInt(settings?.broadcastIdleReleaseSec, 180),
      autoAdvance: settings?.broadcastAutoAdvance === true,
      listenersEnabled: settings?.broadcastListenersEnabled !== false
    }
  }

  const [row] = await db
    .select({
      id: users.id,
      name: users.name,
      username: users.username,
      role: users.role,
      grade: users.grade,
      class: users.class,
      status: users.status
    })
    .from(users)
    .where(eq(users.id, baselineUserId))
    .limit(1)

  const usable =
    !!row &&
    row.status === 'active' &&
    (BROADCAST_BASELINE_ROLES as readonly string[]).includes(row.role)

  return {
    enabled,
    baselineUserId,
    effectiveBaselineUserId: usable ? baselineUserId : null,
    baselineUser: usable ? toCandidateUser(row) : null,
    baselineUserStale: !usable,
    roles: BROADCAST_BASELINE_ROLES,
    baselineLastActiveAt: usable ? getBroadcastLastActiveAt(baselineUserId) : null,
    idleReleaseSec: toPositiveInt(settings?.broadcastIdleReleaseSec, 180),
    autoAdvance: settings?.broadcastAutoAdvance === true,
    listenersEnabled: settings?.broadcastListenersEnabled !== false
  }
}

/** 当前请求者是否具备播控资格（不抛错，用于读接口里的 canBroadcast 判定） */
export function checkBroadcastAuthority(
  user: { id?: number; role?: string; status?: string } | null | undefined,
  authority: BroadcastAuthority
): { allowed: boolean; reason?: string } {
  if (!user || !user.role) {
    return { allowed: false, reason: 'UNAUTHORIZED' }
  }
  if (!(BROADCAST_BASELINE_ROLES as readonly string[]).includes(user.role)) {
    return { allowed: false, reason: 'ROLE' }
  }
  if (user.status !== 'active') {
    return { allowed: false, reason: 'STATUS' }
  }
  if (!authority.enabled) {
    return { allowed: false, reason: 'DISABLED' }
  }
  if (
    authority.effectiveBaselineUserId !== null &&
    Number(user.id) !== authority.effectiveBaselineUserId
  ) {
    return { allowed: false, reason: 'NOT_BASELINE' }
  }
  return { allowed: true }
}

/**
 * 写入基准播控人（接管 / 释放都走这里）。
 * 与 authority.post 里那一坨保持一致：没有设置行时按默认配置新建。
 */
export async function setBroadcastBaselineUserId(userId: number | null): Promise<void> {
  const [existing] = await db.select().from(systemSettings).limit(1)
  if (existing) {
    await db
      .update(systemSettings)
      .set({ broadcastBaselineUserId: userId })
      .where(eq(systemSettings.id, existing.id))
    return
  }
  await db.insert(systemSettings).values({ ...SYSTEM_SETTINGS_DEFAULTS, broadcastBaselineUserId: userId })
}

/** 计算接管结果：不符合条件时给出人话原因 */
export function evaluateTakeover(
  user: { id?: number; role?: string; status?: string } | null | undefined,
  authority: BroadcastAuthority,
  options: { broadcastActive: boolean; now?: number }
): { allowed: boolean; reason?: string } {
  if (!user || !user.role) return { allowed: false, reason: 'UNAUTHORIZED' }
  if (!(BROADCAST_BASELINE_ROLES as readonly string[]).includes(user.role)) {
    return { allowed: false, reason: 'ROLE' }
  }
  if (user.status !== 'active') return { allowed: false, reason: 'STATUS' }
  if (!authority.enabled) return { allowed: false, reason: 'DISABLED' }
  if (authority.effectiveBaselineUserId === null) {
    // 基准是角色放开或已自动释放，直接播就行，不需要「抢」
    return { allowed: false, reason: 'NO_BASELINE' }
  }
  if (Number(user.id) === authority.effectiveBaselineUserId) {
    return { allowed: false, reason: 'ALREADY_BASELINE' }
  }

  if (options.broadcastActive) {
    const now = options.now ?? getServerTimestamp()
    const lastActive = authority.baselineLastActiveAt
    // 广播还在进行且基准人刚发过心跳 → 别抢别人的台
    if (lastActive !== null && now - lastActive <= BROADCAST_BASELINE_ACTIVE_MS) {
      return { allowed: false, reason: 'BASELINE_ACTIVE' }
    }
  }

  return { allowed: true }
}

// 自动释放的检查节流：这个判定要查库，没必要每个请求都做
const AUTO_RELEASE_CHECK_INTERVAL_MS = 20_000
let lastAutoReleaseCheckAt = 0

/**
 * 基准人「跑路」自动解锁。
 *
 * 场景：指定基准播控人后，他播完就关页面了——此时既没有广播在跑，
 * 别人又因为不是基准人而播不了，播控被锁死。这里在检测到
 * 「无广播进行 + 基准人超过阈值无心跳」时把基准释放回角色基准。
 *
 * 注意：广播还在播时绝不动基准锁，避免把正在播出的人挤下去。
 *
 * @returns 被释放的基准人信息；未发生释放时返回 null
 */
export async function maybeReleaseStaleBaseline(options: {
  broadcastActive: boolean
  now?: number
}): Promise<BroadcastCandidateUser | null> {
  if (options.broadcastActive) return null

  const now = options.now ?? getServerTimestamp()
  if (now - lastAutoReleaseCheckAt < AUTO_RELEASE_CHECK_INTERVAL_MS) return null
  lastAutoReleaseCheckAt = now

  const authority = await resolveBroadcastAuthority()
  if (!authority.enabled || authority.effectiveBaselineUserId === null) return null
  // 0 表示管理员明确关掉了自动释放，只接受人工接管
  if (authority.idleReleaseSec <= 0) return null
  // 从未播控过：可能是管理员刚指定好还没来得及开播，不要自作主张解除
  if (authority.baselineLastActiveAt === null) return null
  if (now - authority.baselineLastActiveAt < authority.idleReleaseSec * 1000) return null

  const released = authority.baselineUser
  await setBroadcastBaselineUserId(null)
  console.log(
    `[broadcast] 基准播控人 ${released?.name || authority.effectiveBaselineUserId} 超过 ${authority.idleReleaseSec}s 无播控心跳，已自动释放基准锁`
  )
  return released
}

/**
 * 播控上报门禁：登录 + 歌曲管理员及以上 + 总开关开启 + 命中基准播控人。
 * 不通过时直接抛 401/403，由全局错误处理返回统一信封。
 */
export async function requireBroadcastAuthority(event: H3Event): Promise<BroadcastAuthority> {
  const user = event.context.user
  if (!user) {
    throw createApiError(401, SERVER_ERROR_CODES.AUTH_UNAUTHORIZED, '未授权访问')
  }

  const authority = await resolveBroadcastAuthority()
  const verdict = checkBroadcastAuthority(user, authority)
  if (verdict.allowed) {
    return authority
  }

  if (verdict.reason === 'ROLE') {
    throw createApiError(
      403,
      SERVER_ERROR_CODES.COMMON_INSUFFICIENT_PERMISSION,
      '只有歌曲管理员及以上权限才能对外播报正在播放'
    )
  }
  if (verdict.reason === 'STATUS') {
    throw createApiError(
      403,
      SERVER_ERROR_CODES.AUTH_ACCOUNT_CURRENTLY_UNAVAILABLE,
      '账号状态异常，无法执行此操作'
    )
  }
  if (verdict.reason === 'DISABLED') {
    throw createApiError(
      403,
      SERVER_ERROR_CODES.COMMON_INSUFFICIENT_PERMISSION,
      '播控功能已被管理员关闭'
    )
  }
  if (verdict.reason === 'NOT_BASELINE') {
    const baselineName = authority.baselineUser?.name || `#${authority.effectiveBaselineUserId}`
    throw createApiError(
      403,
      SERVER_ERROR_CODES.COMMON_INSUFFICIENT_PERMISSION,
      `当前基准播控人为 ${baselineName}，你无权对外播报正在播放`
    )
  }
  throw createApiError(403, SERVER_ERROR_CODES.COMMON_INSUFFICIENT_PERMISSION, '无权对外播报正在播放')
}
