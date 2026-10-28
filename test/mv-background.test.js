import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBackground } from '../public/mv-background.js';

test('背景偏好损坏时回退黑色，校验背景类型、颜色和压暗范围', () => {
  assert.deepEqual(normalizeBackground(null), { type: 'color', color: 'rgba(0, 0, 0, 1)', overlayColor: 'rgba(0, 0, 0, 0.35)', pingPong: false });
  assert.deepEqual(normalizeBackground({ type: 'image', color: '#abcDEF', dim: 0.5 }), { type: 'image', color: 'rgba(171, 205, 239, 1)', overlayColor: 'rgba(0, 0, 0, 0.5)', pingPong: false });
  assert.deepEqual(normalizeBackground({ type: 'other', color: 'url(x)', dim: NaN }), normalizeBackground(null));
  assert.equal(normalizeBackground({ type: 'video', dim: 3 }).overlayColor, 'rgba(0, 0, 0, 0.8)');
  assert.equal(normalizeBackground({ dim: -1 }).overlayColor, 'rgba(0, 0, 0, 0)');
  assert.equal(normalizeBackground({ overlayColor: 'rgba(30,40,50,0.2)', dim: 0.7 }).overlayColor, 'rgba(30, 40, 50, 0.2)');
});

test('往返循环仅接受布尔值并保留旧设置的普通循环', () => {
  assert.equal(normalizeBackground({ pingPong: true }).pingPong, true);
  assert.equal(normalizeBackground({ pingPong: 'true' }).pingPong, false);
});
