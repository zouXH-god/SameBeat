import test from 'node:test';
import assert from 'node:assert/strict';
import { positionAt, schedule, activeTimeline } from '../shared/timeline.js';
import { parseLrc } from '../shared/lrc.js';

test('预约播放前位置保持不变，所有媒体使用同一时间轴', () => {
  const stopped = { status: 'STOPPED', positionMs: 0, startServerTime: 0 };
  const playing = schedule(stopped, 'PLAY', 1000, 60000);
  assert.equal(positionAt(playing, 1699, 60000), 0);
  assert.equal(positionAt(playing, 2000, 60000), 300);
  assert.equal(positionAt(playing, 100000, 60000), 60000);
  const paused = schedule(playing, 'PAUSE', 3000, 60000);
  assert.equal(positionAt(paused, 3500, 60000), 1800);
  assert.equal(positionAt(paused, 10000, 60000), 2000);
  const resumed = schedule(paused, 'PLAY', 10000, 60000);
  assert.equal(positionAt(resumed, 11000, 60000), 2300);
});
test('连续控制取消旧的预约，跳转、停止、末尾重播具有确定状态', () => {
  const playing = { status: 'PLAYING', positionMs: 500, startServerTime: 1000 };
  const seek = schedule(playing, 'SEEK', 2000, 10000, 9000);
  assert.equal(positionAt(seek, 2699, 10000), 2199);
  assert.equal(positionAt(seek, 2800, 10000), 9100);
  const stop = schedule(seek, 'STOP', 2200, 10000);
  assert.equal(positionAt(stop, 2800, 10000), 2300);
  assert.equal(positionAt(stop, 3000, 10000), 0);
  assert.equal(activeTimeline(stop, 3000).status, 'STOPPED');
  const replay = schedule({ status: 'ENDED', positionMs: 10000, startServerTime: 0 }, 'PLAY', 0, 10000);
  assert.equal(positionAt(replay, 800, 10000), 100);
});
test('LRC 多时间戳、毫秒、文件偏移、增强标签和无效秒数', () => {
  assert.deepEqual(parseLrc('[offset:-50]\n[00:01.2][00:02.345]一起<00:01.30>听\n[00:99]无效\n[ar:作者]\n[00:00.01]开场'), [
    { timeMs: 0, text: '开场' }, { timeMs: 1150, text: '一起听' }, { timeMs: 2295, text: '一起听' },
  ]);
});

test('方括号逐字时间戳每个物理行只生成一行，重复段落仍按各自时间保留', () => {
  assert.deepEqual(parseLrc('[offset:25]\n[00:01.00]一[00:01.50]起[00:02.00]听[00:02.50]\n[00:05.00]一[00:05.50]起[00:06.00]听[00:06.50]\n[00:08.00][00:12.00]再[00:08.50]来[00:09.00]\n[00:15.00]'), [
    { timeMs: 1025, text: '一起听', endMs: 2525 },
    { timeMs: 5025, text: '一起听', endMs: 6525 },
    { timeMs: 8025, text: '再来', endMs: 9025 },
    { timeMs: 12025, text: '再来', endMs: 13025 },
    { timeMs: 15025, text: '' },
  ]);
});
