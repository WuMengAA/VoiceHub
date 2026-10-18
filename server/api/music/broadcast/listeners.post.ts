import { defineEventHandler, readBody } from 'h3'
import { createApiError } from '~~/server/utils/apiError'
import { SERVER_ERROR_CODES } from '~~/server/config/constants'
import { getSystemSettingsCached } from '~~/server/utils/system-settings-helper'
import { getClientIP } from '~~/server/utils/ip-utils'
import { reportListenerHeartbeat } from '~~/server/utils/broadcast-state'

/**
 * 收听心跳：告诉服务端「我还听着」。
 *
 * 公开接口（学生端无需登录），但一个人头只算一次：
 * 登录用户按 userId 归并，匿名按 SSE 连接 ID 归并，重复上报只是续期。
 * 关掉统计开关时接口照常返回成功，只是不计数——前端不必为了开关分支。
 *
 * 防刷：同一 IP 每秒最多一次有效登记，超额直接返回当前人数，不报错也不计数。
 */
const IP_RATE_WINDOW_MS = 1000
const ipLastSeen = new Map<string, number>()

export default defineEventHandler(async (event) => {
  const settings = await getSystemSettingsCached()
  const enabled = settings ? settings.broadcastListenersEnabled !== false : true
  if (!enabled) {
    return { success: true, listenerCount: 0, counted: false }
  }

  const body = await readBody(event).catch(() => null)
  const payload = body && typeof body === 'object' ? body : {}

  const user = event.context.user
  const connectionId = typeof payload.connectionId === 'string' ? payload.connectionId.trim() : ''
  const key = user?.id ? `user:${user.id}` : connectionId ? `anon:${connectionId}` : ''
  if (!key) {
    throw createApiError(400, SERVER_ERROR_CODES.COMMON_INVALID_PARAMS, '缺少 listener 标识或登录态')
  }

  const ip = getClientIP(event) || 'unknown'
  const now = Date.now()
  const last = ipLastSeen.get(ip) ?? 0
  if (now - last < IP_RATE_WINDOW_MS) {
    return { success: true, counted: false }
  }
  ipLastSeen.set(ip, now)
  if (ipLastSeen.size > 5000) {
    ipLastSeen.clear()
  }

  const listenerCount = reportListenerHeartbeat(key, now)
  return { success: true, listenerCount, counted: true }
})
