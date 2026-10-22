import { db, users } from '~/drizzle/db'
import { eq } from 'drizzle-orm'
import { schedules } from '~/drizzle/schema'

/**
 * 开放 API：重排已发布排期顺序（拖拽排序持久化）
 *
 * 鉴权：api-auth 中间件已按 POST /api/open/schedules/reorder → schedules:write 校验权限。
 * 与 /api/open/songs/request 同款：额外核对令牌所属用户处于 active，避免失效账号的 Key 仍能写。
 *
 * 请求体：{ schedules: [{ id: number, sequence: number }, ...] }（sequence 按新视觉顺序 1..N）
 * 返回：{ success: true, count: number }
 *
 * 注意：sequence 在表内不唯一，跨日期也不会相互污染（服务端 ORDER BY playDate, sequence）。
 * 这里沿用管理端 sequence.post.ts 的逐条更新逻辑，仅把会话鉴权换成 API Key 鉴权。
 */
export default defineEventHandler(async (event) => {
  const apiKey = event.context.apiKey

  if (!apiKey) {
    throw createError({
      statusCode: 401,
      message: 'API认证失败'
    })
  }

  const userResult = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.id, apiKey.createdByUserId))
    .limit(1)
  const user = userResult[0]

  if (!user || user.status !== 'active') {
    throw createError({
      statusCode: 403,
      message: '令牌所属用户不可用'
    })
  }

  try {
    const body = await readBody(event)
    const scheduleUpdates = body.schedules

    if (!Array.isArray(scheduleUpdates) || scheduleUpdates.length === 0) {
      throw createError({
        statusCode: 400,
        message: '缺少排期数据'
      })
    }

    const normalizedUpdates = scheduleUpdates.map((item: any, index: number) => {
      const id = Number(item?.id)
      const sequence = Number(item?.sequence)
      if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(sequence) || sequence <= 0) {
        throw createError({ statusCode: 400, message: `第 ${index + 1} 条排期数据无效` })
      }
      return { id, sequence }
    })

    // 批量更新排期顺序（事务内逐条 UPDATE "Schedule".sequence）
    const results = await db.transaction(async (tx) => {
      const updatedRows = await Promise.all(
        normalizedUpdates.map((item) =>
          tx
            .update(schedules)
            .set({ sequence: item.sequence })
            .where(eq(schedules.id, item.id))
            .returning({ id: schedules.id })
        )
      )

      if (updatedRows.some((rows) => rows.length === 0)) {
        throw createError({ statusCode: 404, message: '部分排期不存在，请刷新后重试' })
      }

      return updatedRows
    })

    return {
      success: true,
      count: results.length
    }
  } catch (error: any) {
    console.error('更新排期顺序失败:', error)

    if (error.statusCode) throw error

    throw createError({
      statusCode: 500,
      message: error.message || '更新排期顺序失败'
    })
  }
})
