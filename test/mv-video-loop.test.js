import test from 'node:test';
import assert from 'node:assert/strict';
import { MvVideoLoop, ReverseFrameCache } from '../public/mv-video-loop.js';

function fixture(cache = null) {
  const events = new Map(), frames = new Map(); let sequence = 0;
  const video = {
    currentTime: 2, duration: 2, seeking: false, loop: true, plays: 0, pauses: 0,
    addEventListener(name, callback) { events.set(name, callback); },
    play() { this.plays++; return Promise.resolve(); },
    pause() { this.pauses++; },
  };
  const loop = new MvVideoLoop(video, () => assert.fail('unexpected playback failure'), callback => {
    frames.set(++sequence, callback); return sequence;
  }, id => frames.delete(id), cache);
  const frame = now => {
    const callbacks = [...frames.values()]; frames.clear();
    callbacks.forEach(callback => callback(now));
  };
  return { video, loop, frames, frame, ended: () => events.get('ended')() };
}

test('正放结束后倒放，回到起点后再次正放，可重复往返', () => {
  const f = fixture();
  f.loop.setEnabled(true); f.loop.update(true);
  assert.equal(f.video.loop, false);
  f.ended(); f.frame(0); f.frame(1000);
  assert.equal(f.video.currentTime, 1);
  f.frame(2000); f.frame(2040);
  assert.equal(f.video.currentTime, 0);
  assert.equal(f.loop.reverse, false);
  assert.equal(f.video.plays, 2);
  f.video.currentTime = 2; f.ended(); f.frame(3000); f.frame(3500);
  assert.equal(f.video.currentTime, 1.5);
});

test('缓存倒放按时间选帧，不再逐帧跳转视频；暂停恢复保留倒放进度', async () => {
  const drawn = [];
  const cache = { canvas: { hidden: true }, complete: true, reset() {}, finish: async () => true, draw: async time => drawn.push(time) };
  const f = fixture(cache);
  f.loop.setEnabled(true); f.loop.update(true); await f.ended();
  f.frame(0); await Promise.resolve(); await Promise.resolve();
  f.frame(500); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(drawn, [2, 1.5]);
  assert.equal(f.video.currentTime, 2, '缓存倒放不触发视频 seek');
  f.loop.update(false); f.loop.update(true); f.frame(10000);
  await Promise.resolve(); await Promise.resolve();
  f.frame(10500); await Promise.resolve(); await Promise.resolve();
  assert.equal(drawn.at(-1), 1);
  f.loop.reset(); assert.equal(f.frames.size, 0);
});

test('倒放帧索引按时间二分定位，跳帧、边界均能处理', () => {
  const cache = { frames: [{ time: 0 }, { time: 0.04 }, { time: 0.08 }, { time: 0.12 }] };
  assert.equal(ReverseFrameCache.prototype.frameAt.call(cache, -1), 0);
  assert.equal(ReverseFrameCache.prototype.frameAt.call(cache, 0.08), 2);
  assert.equal(ReverseFrameCache.prototype.frameAt.call(cache, 0.07), 2);
  assert.equal(ReverseFrameCache.prototype.frameAt.call(cache, 5), 3);
});

test('缓存往返连续跨越两端，保留越界时间且不启动视频播放器', async () => {
  const drawn = [];
  const cache = { canvas: { hidden: false }, complete: true, reset() {}, finish: async () => true,
    draw: async (time, direction) => drawn.push([time, direction]) };
  const f = fixture(cache);
  f.loop.setEnabled(true); await f.ended();
  // ended requires an active player; begin cached playback explicitly here.
  f.loop.active = true; await f.ended();
  f.loop.update(true);
  const step = async now => { f.frame(now); await Promise.resolve(); await Promise.resolve(); };
  await step(0); await step(1980); await step(2020);
  assert.ok(Math.abs(f.loop.position - 0.02) < 1e-8);
  assert.equal(f.loop.reverse, false);
  assert.equal(f.video.currentTime, 2, '转向时不 seek');
  assert.equal(f.video.plays, 0, '重新正放不调用 play');
  assert.equal(cache.canvas.hidden, false, '始终使用同一个画布');
  await step(3980); await step(4020);
  assert.ok(Math.abs(f.loop.position - 1.98) < 1e-8);
  assert.equal(f.loop.reverse, true);
  assert.deepEqual(drawn.map(item => item[1]), [-1, -1, 1, 1, -1]);
  f.loop.update(false); f.loop.update(true);
  await step(10000); await step(10020);
  assert.ok(Math.abs(f.loop.position - 1.96) < 1e-8);
  f.loop.reset(); assert.equal(f.frames.size, 0);
});

test('最近帧采样避免转向端点停留双倍帧时长', () => {
  const cache = { frames: [{ time: 0 }, { time: 0.04 }, { time: 0.08 }] };
  const at = time => ReverseFrameCache.prototype.frameAt.call(cache, time);
  assert.deepEqual([0.05, 0.03, 0.01, 0, 0.01, 0.03, 0.05].map(at), [1, 1, 0, 0, 0, 1, 1]);
});

test('预读窗口跨越起点提前准备正放帧', async () => {
  const requested = [];
  const cache = { frames: Array.from({ length: 20 }, (_, time) => ({ time })), generation: 0,
    frameAt: ReverseFrameCache.prototype.frameAt, drawnIndex: 1, canvas: { hidden: false }, bitmaps: new Map(),
    bitmap(index) { requested.push(index); return Promise.resolve(null); } };
  await ReverseFrameCache.prototype.draw.call(cache, 1, -1);
  assert.ok(requested.includes(0)); assert.ok(requested.includes(7));
  assert.ok(requested.every(index => index >= 0 && index < 20));
});

test('等待新帧时保留显示资源，离屏绘制完成后提交且不清空前台画布', async () => {
  let decoded;
  const waiting = new Promise(resolve => { decoded = resolve; });
  const closed = [], paints = [];
  const makeBitmap = index => ({ width: 20, height: 10, close() { closed.push(index); } });
  const bitmaps = new Map([[2, waiting], ...[0, 15, 18, 19].map(index => [index, Promise.resolve(makeBitmap(index))])]);
  const canvas = { hidden: false, width: 20, height: 10 };
  let resized = 0;
  for (const key of ['width', 'height']) {
    const value = canvas[key];
    Object.defineProperty(canvas, key, { get: () => value, set: () => { resized++; } });
  }
  const cache = { frames: Array.from({ length: 20 }, (_, time) => ({ time })), generation: 0,
    frameAt: ReverseFrameCache.prototype.frameAt, drawnIndex: 18, canvas, bitmaps,
    paintCanvas: { width: 20, height: 10 },
    paintContext: { drawImage() { paints.push('stage'); } }, context: { drawImage() { paints.push('front'); } },
    bitmap(index) {
      if (!bitmaps.has(index)) bitmaps.set(index, Promise.resolve(makeBitmap(index)));
      return bitmaps.get(index);
    } };
  const drawing = ReverseFrameCache.prototype.draw.call(cache, 2, 1);
  await Promise.resolve();
  assert.deepEqual(paints, []);
  assert.equal(canvas.hidden, false);
  assert.deepEqual(closed, [15]);
  decoded(makeBitmap(2)); await drawing;
  assert.deepEqual(paints, ['stage', 'front']);
  assert.equal(resized, 0);
  assert.equal(cache.drawnIndex, 2);
  assert.equal(canvas.hidden, false);
});

test('首次播放先初始化帧缓存，准备中暂停不会意外启动视频', async () => {
  let ready;
  const waiting = new Promise(resolve => { ready = resolve; });
  const cache = { canvas: { hidden: true }, complete: false, prepared: false, reset() {},
    async prepare() { await waiting; this.prepared = true; } };
  const f = fixture(cache); f.video.readyState = 2;
  f.loop.setEnabled(true); f.loop.update(true);
  assert.equal(f.video.plays, 0);
  f.loop.update(false); ready();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.video.plays, 0);
  f.loop.update(true); assert.equal(f.video.plays, 1);
});

test('等待定位完成，后台暂停后继续倒放，更换资源清除旧任务', () => {
  const f = fixture();
  f.loop.setEnabled(true); f.loop.update(true); f.ended(); f.frame(0);
  f.video.seeking = true; f.frame(500);
  assert.equal(f.video.currentTime, 2);
  f.video.seeking = false; f.frame(1000);
  assert.equal(f.video.currentTime, 1);
  f.loop.update(false);
  assert.equal(f.frames.size, 0);
  f.loop.update(true); f.frame(10000); f.frame(10500);
  assert.equal(f.video.currentTime, 0.5);
  f.loop.reset();
  assert.equal(f.loop.reverse, false);
  assert.equal(f.frames.size, 0);
  f.ended(); assert.equal(f.loop.reverse, false);
});

test('倒放中关闭往返循环立即恢复正放与普通循环', () => {
  const f = fixture();
  f.loop.setEnabled(true); f.loop.update(true); f.ended();
  f.loop.setEnabled(false); f.loop.update(true);
  assert.equal(f.video.loop, true);
  assert.equal(f.loop.reverse, false);
  assert.equal(f.frames.size, 0);
  assert.equal(f.video.plays, 2);
});
