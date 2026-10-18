import { defineEventHandler } from 'h3'
import { createApiError } from '~~/server/utils/apiError'
import { SERVER_ERROR_CODES } from '~~/server/config/constants'
import {
  BROADCAST_BASELINE_ROLES,
  checkBroadcastAuthority,
  evaluateTakeover,
  listBroadcastCandidates,
  maybeReleaseStaleBaseline,
  resolveBroadcastAuthority
} from '~~/server/utils/broadcast-authority'
import { getBroadcastSnapshot } from '~~/server/utils/broadcast-state'

/** 可以修改播控基准的角色（比可播控角色更严一档：设置权归管理员） */
const BROADCAST_CONFIG_ROLES = ['ADMIN', 'SUPER_ADMIN']

/**
 * 读取播控基准配置，供播控端界面渲染「基准播控人」「谁能改」「能不能接管」。
 *
 * 需要登录且为歌曲管理员及以上——学生端不需要这个接口，
 * 它只服务播控端界面，避免把教职工名单暴露给所有人。
 */
export default defineEventHandler(async (event) => {
  const user = event.context.user
  if (!user) {
    throw createApiError(401, SERVER_ERROR_CODES.AUTH_UNAUTHORIZED, '未授权访问')
  }
  if (!(BROADCAST_BASELINE_ROLES as readonly string[]).includes(user.role)) {
    throw createApiError(
      403,
      SERVER_ERROR_CODES.COMMON_INSUFFICIENT_PERMISSION,
      '只有歌曲管理员及以上权限才能查看播控配置'
    )
  }

  // 先看一眼基准人是不是已经跑路了（内部有节流），没人在线时播控不该被一个人锁死
  const snapshot = getBroadcastSnapshot()
  await maybeReleaseStaleBaseline({ broadcastActive: Boolean(snapshot) })

  const authority = await resolveBroadcastAuthority()
  const canEdit = BROADCAST_CONFIG_ROLES.includes(user.role)
  const verdict = checkBroadcastAuthority(user, authority)
  const takeover = evaluateTakeover(user, authority, { broadcastActive: Boolean(snapshot) })

  return {
    success: true,
    authority,
    canBroadcast: verdict.allowed,
    /** 不具备播控资格时的原因：ROLE / STATUS / DISABLED / NOT_BASELINE */
    denyReason: verdict.allowed ? null : verdict.reason ?? null,
    /** 能否立即接管播控权 */
    canTakeover: takeover.allowed,
    /** 不能接管时的原因：NO_BASELINE 无人占位 / ALREADY_BASELINE 已是基准 / BASELINE_ACTIVE 对方还在播 */
    takeoverDenyReason: takeover.allowed ? null : takeover.reason ?? null,
    /** 当前是否有广播在播（界面据此判断该显示「接管」还是「开始播控」） */
    broadcastActive: Boolean(snapshot),
    canEdit,
    // 教职工名单只在管理员侧下发，歌曲管理员只需知道「基准是谁」
    candidates: canEdit ? await listBroadcastCandidates() : []
  }
})
