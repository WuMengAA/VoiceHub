import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyBroadcastReport,
  getBroadcastSnapshot,
  stopBroadcast
} from '../../server/utils/broadcast-state.ts'

const baseReport = {
  songId: 42,
  title: '轨迹',
  artist: '周杰伦',
  cover: 'https://example.com/cover.jpg',
  musicPlatform: 'netease',
  musicId: '186016',
  duration: 200,
  position: 30,
  isPlaying: true,
  scheduleId: 7,
  playDate: '2026-09-17',
  sequence: 2,
  publisherName: '播音员'
}

test('没有广播时快照为空', () => {
  stopBroadcast()
  assert.equal(getBroadcastSnapshot(), null)
})

test('上报播放状态后返回完整快照', () => {
  stopBroadcast()
  const snapshot = applyBroadcastReport(baseReport)
  assert.ok(snapshot)
  assert.equal(snapshot.songId, 42)
  assert.equal(snapshot.title, '轨迹')
  assert.equal(snapshot.artist, '周杰伦')
  assert.equal(snapshot.scheduleId, 7)
  assert.equal(snapshot.playDate, '2026-09-17')
  assert.equal(snapshot.sequence, 2)
  assert.equal(snapshot.duration, 200)
  assert.equal(snapshot.isPlaying, true)
  assert.equal(snapshot.publisherName, '播音员')
})

test('播放中进度按时间外推', () => {
  stopBroadcast()
  applyBroadcastReport({ ...baseReport, position: 10 })
  const later = getBroadcastSnapshot(Date.now() + 5000)
  assert.ok(later)
  // 容差放宽到 1 秒，避免测试机调度抖动导致误判
  assert.ok(later.position >= 14.5 && later.position <= 16, `实际进度 ${later.position}`)
})

test('暂停时进度不外推', () => {
  stopBroadcast()
  applyBroadcastReport({ ...baseReport, position: 12, isPlaying: false })
  const later = getBroadcastSnapshot(Date.now() + 5000)
  assert.ok(later)
  assert.equal(later.isPlaying, false)
  assert.equal(later.position, 12)
})

test('进度上报不覆盖已有歌曲元数据', () => {
  stopBroadcast()
  applyBroadcastReport(baseReport)
  const snapshot = applyBroadcastReport({ songId: 42, position: 80 })
  assert.ok(snapshot)
  assert.equal(snapshot.title, '轨迹')
  assert.equal(snapshot.artist, '周杰伦')
  assert.equal(snapshot.cover, 'https://example.com/cover.jpg')
  assert.equal(snapshot.scheduleId, 7)
  assert.equal(snapshot.duration, 200)
  assert.equal(snapshot.position, 80)
})

test('切歌时替换元数据并解绑上一条排期', () => {
  stopBroadcast()
  applyBroadcastReport(baseReport)
  const snapshot = applyBroadcastReport({
    songId: 99,
    title: '新歌',
    artist: '别的歌手',
    position: 0
  })
  assert.ok(snapshot)
  assert.equal(snapshot.songId, 99)
  assert.equal(snapshot.title, '新歌')
  assert.equal(snapshot.artist, '别的歌手')
  assert.equal(snapshot.cover, null)
  assert.equal(snapshot.scheduleId, null)
  assert.equal(snapshot.playDate, null)
})

test('结束广播后快照为空', () => {
  applyBroadcastReport(baseReport)
  stopBroadcast()
  assert.equal(getBroadcastSnapshot(), null)
})

test('播放中长时间无上报判定为已结束', () => {
  stopBroadcast()
  // duration 为 0 时只受无上报空窗约束，单独校验该规则
  applyBroadcastReport({ ...baseReport, duration: 0 })
  assert.ok(getBroadcastSnapshot(Date.now() + 60_000))
  assert.equal(getBroadcastSnapshot(Date.now() + 100_000), null)
})

test('进度超出总时长超过容差判定为播完', () => {
  stopBroadcast()
  applyBroadcastReport({ ...baseReport, duration: 60, position: 59 })
  assert.ok(getBroadcastSnapshot(Date.now() + 3000))
  assert.equal(getBroadcastSnapshot(Date.now() + 20_000), null)
})

test('暂停状态保留较长时间后自动失效', () => {
  stopBroadcast()
  applyBroadcastReport({ ...baseReport, duration: 0, position: 5, isPlaying: false })
  assert.ok(getBroadcastSnapshot(Date.now() + 10 * 60_000))
  assert.equal(getBroadcastSnapshot(Date.now() + 31 * 60_000), null)
})

test('总时长大于进度时进度不会超过总时长', () => {
  stopBroadcast()
  applyBroadcastReport({ ...baseReport, duration: 100, position: 99 })
  const snapshot = getBroadcastSnapshot(Date.now() + 3000)
  assert.ok(snapshot)
  assert.equal(snapshot.position, 100)
})

test('非法歌曲 ID 不产生新的广播状态', () => {
  stopBroadcast()
  assert.equal(applyBroadcastReport({ songId: 0, title: '无效' }), null)
  assert.equal(getBroadcastSnapshot(), null)
})
