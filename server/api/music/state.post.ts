import { defineEventHandler, readBody } from 'h3'
import { broadcastMusicState, broadcastSongChange } from './websocket'
import {
  markBroadcastActivity,
  requireBroadcastAuthority
} from '~~/server/utils/broadcast-authority'

/**
 * 旧版音乐状态通道（HarmonyOS 播放端在用），保留原有 SSE 消息类型以免打断既有客户端。
 *
 * 安全修正：该路由原先是匿名可写的公共路由（见 auth-route-policy 的历史配置），
 * 任何人都能往全体 SSE 订阅者推送伪造的「正在播放」，因此改为与新版播控同一套门禁：
 * 登录 + 命中播控基准（角色基准 / 基准播控人 + 总开关）。
 * 新的播控端应改用 POST /api/music/broadcast（支持排期绑定、进度外推与统一快照）。
 */
export default defineEventHandler(async (event) => {
  const authority = await requireBroadcastAuthority(event)
  const user = event.context.user

  // 旧通道同样算作播控心跳：否则只有旧客户端在播时，会被误判成「基准人跑路」而自动释放基准锁
  markBroadcastActivity(user?.id)

  try {
    const body = await readBody(event)

    // 验证请求数据
    if (!body || typeof body !== 'object') {
      throw createError({
        statusCode: 400,
        message: '无效的请求数据'
      })
    }

    const { type, data } = body

    switch (type) {
      case 'state_update':
        // 音乐状态更新
        if (data && typeof data === 'object') {
          const musicState = {
            songId: data.songId,
            isPlaying: Boolean(data.isPlaying),
            position: Number(data.position) || 0,
            duration: Number(data.duration) || 0,
            volume: Number(data.volume) || 1,
            playlistIndex: data.playlistIndex,
            timestamp: Date.now()
          }

          // 广播状态更新
          broadcastMusicState(musicState)

          return {
            success: true,
            message: '音乐状态已更新'
          }
        }
        break

      case 'song_change':
        // 歌曲切换
        if (data && typeof data === 'object') {
          const songInfo = {
            songId: data.songId,
            title: data.title || '',
            artist: data.artist || '',
            cover: data.cover || '',
            duration: Number(data.duration) || 0,
            playlistIndex: data.playlistIndex,
            timestamp: Date.now()
          }

          // 广播歌曲切换
          broadcastSongChange(songInfo)

          return {
            success: true,
            message: '歌曲切换已广播'
          }
        }
        break

      case 'position_update':
        // 播放位置更新
        if (data && typeof data === 'object') {
          const positionState = {
            songId: data.songId,
            isPlaying: Boolean(data.isPlaying),
            position: Number(data.position) || 0,
            duration: Number(data.duration) || 0,
            volume: Number(data.volume) || 1,
            timestamp: Date.now()
          }

          // 广播位置更新
          broadcastMusicState(positionState)

          return {
            success: true,
            message: '播放位置已更新'
          }
        }
        break

      default:
        throw createError({
          statusCode: 400,
          message: '不支持的操作类型'
        })
    }

    throw createError({
      statusCode: 400,
      message: '无效的请求数据'
    })
  } catch (error: any) {
    console.error('Music state update error:', error)

    if (error.statusCode) {
      throw error
    }

    throw createError({
      statusCode: 500,
      message: '服务器内部错误'
    })
  }
})
