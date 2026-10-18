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
  evaluateTakeover,
  listBroadcastCandidates,
  markBroadcastActivity,
  resolveBroadcastAuthority,
  setBroadcastBaselineUserId
} from '~~/server/utils/broadcast-authority'
import { getBroadcastSnapshot, stopBroadcast } from '~~/server/utils/broadcast-state'
import { broadcastBroadcastState } from '~~/server/api/music/websocket'

/** 可以修改播控基准的角色（比可播控角色更严一档：设置权归管理员） */
const BROADCAST_CONFIG_ROLES = ['ADMIN', 'SUPER_ADMIN']

/**
 * 修改播控基准配置。
 *
 * - enabled：总开关。关闭时立即清空在播状态并通知所有订阅者，学生端马上收起「正在播放」。
 * - baselineUserId：基准播控人。传 null 表示按「歌曲管理员及以上」角色放开；
 *   传具体用户 ID 时必须是角色合规且账号正常的用户，避免把播控锁死在一个不存在的人身上。
 * - autoAdvance：自动连播，曲目播完自动切到播放单里的下一首。
 * - idleReleaseSec：基准人无心跳多久后自动释放基准锁（0 = 关闭自动释放）。
 * - listenersEnabled：是否统计并对外下发在线收听人数。
 *
 * 另有 action 不走配置表单：
 * - claim：接管播控权（把基准人改成自己，用于「基准人跑了」的情况）
 * - release：交还/释放基准锁（改回角色基准）
 */
export default defineEventHandler(async (event) => {
  const user = event.context.user
  if (!user) {
    throw createApiError(401, SERVER_ERROR_CODES.AUTH_UNAUTHORIZED, '未授权访问')
  }

  const body = await readBody(event).catch(() => null)
  if (!body || typeof body !== 'object') {
    throw createApiError(400, SERVER_ERROR_CODES.COMMON_INVALID_PARAMS, '无效的请求数据')
  }

  // 接管 / 释放是播控端自助动作，歌曲管理员即可；改全局配置才要求管理员及以上
  if (body.action === 'claim' || body.action === 'release') {
    return await handleBaselineTransfer(user, body.action)
  }

  if (!BROADCAST_CONFIG_ROLES.includes(user.role)) {
    throw createApiError(
      403,
      SERVER_ERROR_CODES.COMMON_INSUFFICIENT_PERMISSION,
      '只有管理员及以上权限才能修改播控配置'
    )
  }

  const updateData: Partial<{
    broadcastEnabled: boolean
    broadcastBaselineUserId: number | null
    broadcastAutoAdvance: boolean
    broadcastIdleReleaseSec: number
    broadcastListenersEnabled: boolean
  }> = {}

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

  if (Object.prototype.hasOwnProperty.call(body, 'autoAdvance')) {
    if (typeof body.autoAdvance !== 'boolean') {
      throw createApiError(400, SERVER_ERROR_CODES.COMMON_INVALID_PARAMS, 'autoAdvance 必须是布尔值')
    }
    updateData.broadcastAutoAdvance = body.autoAdvance
  }

  if (Object.prototype.hasOwnProperty.call(body, 'idleReleaseSec')) {
    const seconds = Number(body.idleReleaseSec)
    // 0 表示关闭自动释放；上限 1 小时，再长等同于锁死，没意义
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3600) {
      throw createApiError(
        400,
        SERVER_ERROR_CODES.COMMON_INVALID_PARAMS,
        'idleReleaseSec 必须是 0-3600 之间的整数'
      )
    }
    updateData.broadcastIdleReleaseSec = seconds
  }

  if (Object.prototype.hasOwnProperty.call(body, 'listenersEnabled')) {
    if (typeof body.listenersEnabled !== 'boolean') {
      throw createApiError(
        400,
        SERVER_ERROR_CODES.COMMON_INVALID_PARAMS,
        'listenersEnabled 必须是布尔值'
      )
    }
    updateData.broadcastListenersEnabled = body.listenersEnabled
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
    stopBroadcast('DISABLED')
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

/**
 * 处理 claim（接管）/ release（释放）基准锁。
 *
 * - claim：把自己设为基准播控人，并把当前在播内容结算为 TAKEOVER 后清空。
 *   只在「无人占位」或「占位者已失联」时允许，避免直播到一半被人挤下去。
 * - release：主动交还基准锁，改回「歌曲管理员及以上都能播」。
 *   当前基准人本人或管理员可以操作。
 */
async function handleBaselineTransfer(
  user: { id?: number; role?: string; status?: string },
  action: 'claim' | 'release'
) {
  if (!user?.id) {
    throw createApiError(401, SERVER_ERROR_CODES.AUTH_UNAUTHORIZED, '未授权访问')
  }

  const authority = await resolveBroadcastAuthority()
  const snapshot = getBroadcastSnapshot()

  if (action === 'claim') {
    const takeover = evaluateTakeover(user, authority, { broadcastActive: Boolean(snapshot) })
    if (!takeover.allowed) {
      const messages: Record<string, string> = {
        ROLE: '只有歌曲管理员及以上权限才能接管播控',
        STATUS: '账号状态异常，无法接管播控',
        DISABLED: '播控功能已被管理员关闭',
        NO_BASELINE: '当前没有指定基准播控人，直接开始播控即可',
        ALREADY_BASELINE: '你已经是基准播控人了',
        BASELINE_ACTIVE: `基准播控人 ${
          authority.baselineUser?.name || `#${authority.effectiveBaselineUserId}`
        } 仍在播控中，暂时无法接管`
      }
      throw createApiError(
        403,
        SERVER_ERROR_CODES.COMMON_INSUFFICIENT_PERMISSION,
        messages[takeover.reason ?? ''] || '当前无法接管播控权'
      )
    }

    await setBroadcastBaselineUserId(Number(user.id))
    markBroadcastActivity(Number(user.id))

    // 接管的语义是「这一摊归我了」：旧基准人播的内容先结算掉，避免两边状态打架
    stopBroadcast('TAKEOVER')
    broadcastBroadcastState(null)
  } else {
    const isBaselineOwner =
      authority.effectiveBaselineUserId !== null &&
      Number(user.id) === authority.effectiveBaselineUserId
    const isAdmin = BROADCAST_CONFIG_ROLES.includes(user.role || '')
    if (!isBaselineOwner && !isAdmin) {
      throw createApiError(
        403,
        SERVER_ERROR_CODES.COMMON_INSUFFICIENT_PERMISSION,
        '只有基准播控人本人或管理员才能释放基准锁'
      )
    }
    if (authority.effectiveBaselineUserId === null) {
      throw createApiError(
        400,
        SERVER_ERROR_CODES.COMMON_INVALID_PARAMS,
        '当前没有指定基准播控人，无需释放'
      )
    }
    await setBroadcastBaselineUserId(null)
  }

  const next = await resolveBroadcastAuthority()
  const verdict = checkBroadcastAuthority(user, next)
  return {
    success: true,
    authority: next,
    canBroadcast: verdict.allowed,
    denyReason: verdict.allowed ? null : verdict.reason ?? null,
    canTakeover: false,
    takeoverDenyReason: next.effectiveBaselineUserId !== null ? 'ALREADY_BASELINE' : 'NO_BASELINE',
    broadcastActive: Boolean(getBroadcastSnapshot()),
    canEdit: BROADCAST_CONFIG_ROLES.includes(user.role || ''),
    candidates: BROADCAST_CONFIG_ROLES.includes(user.role || '')
      ? await listBroadcastCandidates()
      : []
  }
}
