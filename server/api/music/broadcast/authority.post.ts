import { defineEventHandler, readBody } from 'h3'
import { db } from '~/drizzle/db'
import { systemSettings, users } from '~/drizzle/schema'
import { eq } from 'drizzle-orm'
import { createApiError } from '~~/server/utils/apiError'
import { SERVER_ERROR_CODES } from '~~/server/config/constants'
import { SYSTEM_SETTINGS_DEFAULTS } from '~~/server/utils/system-settings-defaults'
import {
  BROADCAST_BASELINE_ROLES,
  checkBroadcastAuthority,
  listBroadcastCandidates,
  resolveBroadcastAuthority
} from '~~/server/utils/broadcast-authority'
import { stopBroadcast } from '~~/server/utils/broadcast-state'
import { broadcastBroadcastState } from '~~/server/api/music/websocket'

/** 可以修改播控基准的角色（比可播控角色更严一档：设置权归管理员） */
const BROADCAST_CONFIG_ROLES = ['ADMIN', 'SUPER_ADMIN']

/**
 * 修改播控基准配置。
 *
 * - enabled：总开关。关闭时立即清空在播状态并通知所有订阅者，学生端马上收起「正在播放」。
 * - baselineUserId：基准播控人。传 null 表示按「歌曲管理员及以上」角色放开；
 *   传具体用户 ID 时必须是角色合规且账号正常的用户，避免把播控锁死在一个不存在的人身上。
 */
export default defineEventHandler(async (event) => {
  const user = event.context.user
  if (!user) {
    throw createApiError(401, SERVER_ERROR_CODES.AUTH_UNAUTHORIZED, '未授权访问')
  }
  if (!BROADCAST_CONFIG_ROLES.includes(user.role)) {
    throw createApiError(
      403,
      SERVER_ERROR_CODES.COMMON_INSUFFICIENT_PERMISSION,
      '只有管理员及以上权限才能修改播控配置'
    )
  }

  const body = await readBody(event).catch(() => null)
  if (!body || typeof body !== 'object') {
    throw createApiError(400, SERVER_ERROR_CODES.COMMON_INVALID_PARAMS, '无效的请求数据')
  }

  const updateData: { broadcastEnabled?: boolean; broadcastBaselineUserId?: number | null } = {}

  if (Object.prototype.hasOwnProperty.call(body, 'enabled')) {
    if (typeof body.enabled !== 'boolean') {
      throw createApiError(400, SERVER_ERROR_CODES.COMMON_INVALID_PARAMS, 'enabled 必须是布尔值')
    }
    updateData.broadcastEnabled = body.enabled
  }

  if (Object.prototype.hasOwnProperty.call(body, 'baselineUserId')) {
    const raw = body.baselineUserId
    if (raw === null || raw === '' || raw === undefined) {
      updateData.broadcastBaselineUserId = null
    } else {
      const baselineUserId = Number(raw)
      if (!Number.isInteger(baselineUserId) || baselineUserId <= 0) {
        throw createApiError(400, SERVER_ERROR_CODES.COMMON_INVALID_PARAMS, '基准播控人 ID 无效')
      }

      const [candidate] = await db
        .select({ id: users.id, role: users.role, status: users.status })
        .from(users)
        .where(eq(users.id, baselineUserId))
        .limit(1)

      if (!candidate) {
        throw createApiError(400, SERVER_ERROR_CODES.COMMON_INVALID_PARAMS, '所选用户不存在')
      }
      if (
        candidate.status !== 'active' ||
        !(BROADCAST_BASELINE_ROLES as readonly string[]).includes(candidate.role)
      ) {
        throw createApiError(
          400,
          SERVER_ERROR_CODES.COMMON_INVALID_PARAMS,
          '基准播控人必须是账号正常的歌曲管理员及以上用户'
        )
      }

      updateData.broadcastBaselineUserId = baselineUserId
    }
  }

  if (Object.keys(updateData).length === 0) {
    throw createApiError(400, SERVER_ERROR_CODES.COMMON_INVALID_PARAMS, '没有需要更新的配置项')
  }

  const [existing] = await db.select().from(systemSettings).limit(1)
  if (existing) {
    await db.update(systemSettings).set(updateData).where(eq(systemSettings.id, existing.id))
  } else {
    await db
      .insert(systemSettings)
      .values({ ...SYSTEM_SETTINGS_DEFAULTS, ...updateData })
  }

  // 关掉总开关时立刻停播：否则学生端要等到状态过期才会收起「正在播放」
  if (updateData.broadcastEnabled === false) {
    stopBroadcast()
    broadcastBroadcastState(null)
  }

  const authority = await resolveBroadcastAuthority()
  const verdict = checkBroadcastAuthority(user, authority)

  return {
    success: true,
    authority,
    canBroadcast: verdict.allowed,
    denyReason: verdict.allowed ? null : verdict.reason ?? null,
    canEdit: true,
    candidates: await listBroadcastCandidates()
  }
})
