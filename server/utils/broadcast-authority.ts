import type { H3Event } from 'h3'
import { db, users } from '~/drizzle/db'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { createApiError } from '~~/server/utils/apiError'
import { SERVER_ERROR_CODES } from '~~/server/config/constants'
import { getSystemSettingsCached } from '~~/server/utils/system-settings-helper'

/**
 * 基准播控角色：校园广播的「正在播放」由歌曲管理员起步的角色对外播报。
 * 这与 requireSongAdmin 保持一致——权限只放宽到不能再宽，收紧则靠基准用户。
 */
export const BROADCAST_BASELINE_ROLES = ['SONG_ADMIN', 'ADMIN', 'SUPER_ADMIN'] as const

/** 可被选为基准播控人的用户（用于后台下拉框） */
export interface BroadcastCandidateUser {
  id: number
  name: string
  username: string
  role: string
  grade: string | null
  class: string | null
}

/** 当前生效的播控基准 */
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
      roles: BROADCAST_BASELINE_ROLES
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
    roles: BROADCAST_BASELINE_ROLES
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
