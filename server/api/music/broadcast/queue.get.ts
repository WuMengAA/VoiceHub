import { defineEventHandler } from 'h3'
import { createApiError } from '~~/server/utils/apiError'
import { SERVER_ERROR_CODES } from '~~/server/config/constants'
import { BROADCAST_BASELINE_ROLES, resolveBroadcastAuthority } from '~~/server/utils/broadcast-authority'
import { getBroadcastQueue, getNextQueueItem } from '~~/server/utils/broadcast-state'

/**
 * 读取播放单（连播队列）。
 *
 * 歌曲管理员及以上可读：他们需要知道自己排的单是什么样。
 * 学生端通过 /api/music/broadcast 的 nextUp 字段拿「下一首」就够了，
 * 不需要知道完整队列，也不用登录。
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
      '只有歌曲管理员及以上权限才能查看播放单'
    )
  }

  const authority = await resolveBroadcastAuthority()
  const { items, currentIndex } = getBroadcastQueue()

  return {
    success: true,
    queue: items,
    currentIndex,
    nextUp: getNextQueueItem(),
    autoAdvance: authority.autoAdvance
  }
})
