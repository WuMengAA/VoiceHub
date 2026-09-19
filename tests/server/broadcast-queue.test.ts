import assert from 'node:assert/strict'
import test from 'node:test'
import {
  advanceBroadcast,
  applyBroadcastReport,
  clearBroadcastQueue,
  consumePlayLogEvents,
  getBroadcastQueue,
  getBroadcastSnapshot,
  setBroadcastQueue,
  stopBroadcast,
  syncBroadcastSession,
  type BroadcastQueueItem
} from '../../server/utils/broadcast-state.ts'
import {
  countActiveListeners,
  removeListener,
  resetListeners,
  sweepListeners,
  touchListener
} from '../../server/utils/broadcast-listeners.ts'

const makeItem = (songId: number, title = `歌曲${songId}`): BroadcastQueueItem => ({
  songId,
  title,
  artist: `歌手${songId}`,
  cover: null,
  musicPlatform: 'netease',
  musicId: String(songId),
  duration: 100,
  scheduleId: songId * 10,
  playDate: '2026-09-18',
  sequence: songId
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const reset = () => {
  stopBroadcast()
  clearBroadcastQueue()
  consumePlayLogEvents()
}

// —— 播放单与「下一首」 ——

test('设置播放单后 nextUp 指向第二首', () => {
  reset()
  applyBroadcastReport({
    songId: 1,
    title: '第一首',
    artist: 'A',
    duration: 100,
    position: 0,
    isPlaying: true
  })
  setBroadcastQueue([makeItem(1), makeItem(2), makeItem(3)], 1)

  const snapshot = getBroadcastSnapshot()
  assert.ok(snapshot)
  assert.equal(snapshot.nextUp?.songId, 2)
  assert.equal(snapshot.queueRemaining, 2)

  const { items, currentIndex } = getBroadcastQueue()
  assert.equal(items.length, 3)
  assert.equal(currentIndex, 0)
})

test('播放单不含当前曲目时，游标回到 -1，下一首取第一条', () => {
  reset()
  applyBroadcastReport({
    songId: 99,
    title: '临时插播',
    artist: 'A',
    duration: 100,
    position: 0,
    isPlaying: true
  })
  setBroadcastQueue([makeItem(5), makeItem(6)], 99)

  const snapshot = getBroadcastSnapshot()
  assert.equal(snapshot?.nextUp?.songId, 5)
  assert.equal(getBroadcastQueue().currentIndex, -1)
})

// —— 连播推进 ——

test('手动推进：切到下一首并结算上一首的播出日志', () => {
  reset()
  applyBroadcastReport({
    songId: 1,
    title: '第一首',
    artist: 'A',
    duration: 100,
    position: 0,
    isPlaying: true,
    publisherId: 7,
    publisherName: '播音员'
  })
  setBroadcastQueue([makeItem(1), makeItem(2)], 1)
  consumePlayLogEvents()

  const next = advanceBroadcast('SWITCHED')
  assert.ok(next)
  assert.equal(next.songId, 2)
  assert.equal(next.isPlaying, true)
  assert.equal(next.position, 0)
  assert.equal(next.nextUp, null)
  // 播控人身份跟随会话保留，否则日志里接管的那一段就查不到人
  assert.equal(next.publisherId, 7)

  const events = consumePlayLogEvents()
  assert.equal(events.length, 2)
  assert.equal(events[0].type, 'end')
  assert.equal(events[0].endReason, 'SWITCHED')
  assert.equal(events[0].songId, 1)
  assert.equal(events[1].type, 'start')
  assert.equal(events[1].songId, 2)
})

test('播放单播完后推进返回 null', () => {
  reset()
  applyBroadcastReport({ songId: 1, title: 'x', artist: 'y', duration: 10, position: 9, isPlaying: true })
  setBroadcastQueue([makeItem(1)], 1)
  consumePlayLogEvents()

  assert.equal(advanceBroadcast(), null)
  assert.deepEqual(consumePlayLogEvents(), [])
})

test('未播完不自动连播；播到结尾且开启开关才推进', () => {
  reset()
  applyBroadcastReport({
    songId: 1,
    title: '第一首',
    artist: 'A',
    duration: 60,
    position: 0,
    isPlaying: true
  })
  setBroadcastQueue([makeItem(1), makeItem(2)], 1)

  // 才播了 10 秒，不该被拉到下一首
  const early = syncBroadcastSession({ autoAdvance: true })
  assert.equal(early.changed, false)
  assert.equal(early.snapshot?.songId, 1)

  // 播到结尾（60s）后、还在 5 秒播完容差内，应自动推进
  const finished = syncBroadcastSession({
    autoAdvance: true,
    now: Date.now() + 62_000
  })
  assert.equal(finished.changed, true)
  assert.equal(finished.snapshot?.songId, 2)
})

test('关闭自动连播时即使播完也不推进', () => {
  reset()
  applyBroadcastReport({
    songId: 1,
    title: '第一首',
    artist: 'A',
    duration: 60,
    position: 0,
    isPlaying: true
  })
  setBroadcastQueue([makeItem(1), makeItem(2)], 1)

  const result = syncBroadcastSession({ autoAdvance: false, now: Date.now() + 62_000 })
  assert.equal(result.changed, false)
  assert.equal(result.snapshot?.songId, 1)
})

test('播控端失联到过期时不做自动连播，直接收起广播', () => {
  reset()
  applyBroadcastReport({
    songId: 1,
    title: '第一首',
    artist: 'A',
    duration: 60,
    position: 0,
    isPlaying: true
  })
  setBroadcastQueue([makeItem(1), makeItem(2)], 1)

  // 超过 90s 失联窗口：人已经跑了，不该替他开下一首
  const result = syncBroadcastSession({ autoAdvance: true, now: Date.now() + 120_000 })
  assert.equal(result.changed, true)
  assert.equal(result.snapshot, null)
  assert.equal(getBroadcastQueue().currentIndex, 0)
})

test('暂停中的曲目不会被自动连播切走', () => {
  reset()
  applyBroadcastReport({
    songId: 1,
    title: '第一首',
    artist: 'A',
    duration: 100,
    position: 99,
    isPlaying: false
  })
  setBroadcastQueue([makeItem(1), makeItem(2)], 1)

  const result = syncBroadcastSession({ autoAdvance: true })
  assert.equal(result.changed, false)
  assert.equal(result.snapshot?.songId, 1)
})

// —— 播出日志 ——

test('切换歌曲时会结束上一首的日志并为新歌开新会话', () => {
  reset()
  applyBroadcastReport({
    songId: 1,
    title: '第一首',
    artist: 'A',
    duration: 100,
    position: 10,
    isPlaying: true
  })
  consumePlayLogEvents()

  applyBroadcastReport({
    songId: 2,
    title: '第二首',
    artist: 'B',
    duration: 120,
    position: 0,
    isPlaying: true
  })

  const events = consumePlayLogEvents()
  assert.equal(events.length, 2)
  assert.equal(events[0].type, 'end')
  assert.equal(events[0].songId, 1)
  assert.equal(events[0].endReason, 'SWITCHED')
  assert.equal(events[1].type, 'start')
  assert.equal(events[1].songId, 2)
  assert.equal(events[1].title, '第二首')
})

test('结束广播时结算播出时长并记录 STOPPED', async () => {
  reset()
  applyBroadcastReport({
    songId: 3,
    title: '第三首',
    artist: 'C',
    duration: 100,
    position: 0,
    isPlaying: true,
    publisherId: 9,
    publisherName: '播音员B'
  })
  consumePlayLogEvents()

  await sleep(1100)
  stopBroadcast('STOPPED')

  const events = consumePlayLogEvents()
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'end')
  assert.equal(events[0].endReason, 'STOPPED')
  assert.equal(events[0].publisherId, 9)
  assert.ok(events[0].playedSeconds !== undefined && events[0].playedSeconds >= 1,
    `实际播出秒数 ${events[0].playedSeconds}`)
})

test('暂停时长不计入播出秒数', async () => {
  reset()
  applyBroadcastReport({ songId: 4, title: 'x', artist: 'y', duration: 100, position: 0, isPlaying: true })
  await sleep(1000)
  // 暂停并等待一段——这段时间不该被算进播出时长
  applyBroadcastReport({ songId: 4, title: 'x', artist: 'y', duration: 100, position: 1, isPlaying: false })
  await sleep(400)
  consumePlayLogEvents()
  stopBroadcast('STOPPED')

  const events = consumePlayLogEvents()
  const played = events[0]?.playedSeconds ?? 0
  assert.ok(played >= 1 && played <= 2, `暂停后仍被计入：${played}s`)
})

test('播控端失联导致过期时记 EXPIRED', () => {
  reset()
  applyBroadcastReport({ songId: 5, title: 'x', artist: 'y', duration: 100, position: 0, isPlaying: true })
  consumePlayLogEvents()

  assert.equal(getBroadcastSnapshot(Date.now() + 120_000), null)
  const events = consumePlayLogEvents()
  assert.equal(events.length, 1)
  assert.equal(events[0].endReason, 'EXPIRED')
})

// —— 在线收听人数 ——

test('同一 key 重复上报只算一个人头', () => {
  resetListeners()
  touchListener('user:1')
  touchListener('user:1')
  touchListener('user:2')
  assert.equal(countActiveListeners(), 2)
})

test('收听者断开后立即注销', () => {
  resetListeners()
  touchListener('anon:abc')
  touchListener('anon:def')
  removeListener('anon:abc')
  assert.equal(countActiveListeners(), 1)
})

test('超过 TTL 未续期的收听者会被清掉', () => {
  resetListeners()
  const now = Date.now()
  touchListener('user:9', now)
  assert.equal(countActiveListeners(now), 1)
  // 心跳窗口 45s，超过后不再计入
  sweepListeners(now + 50_000)
  assert.equal(countActiveListeners(now + 50_000), 0)
})

test('广播快照带上在线收听人数', () => {
  resetListeners()
  touchListener('user:1')
  touchListener('user:2')
  reset()
  applyBroadcastReport({ songId: 6, title: 'x', artist: 'y', duration: 100, position: 0, isPlaying: true })
  const snapshot = getBroadcastSnapshot()
  assert.equal(snapshot?.listenerCount, 2)
  resetListeners()
})

reset()
