import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRgba, normalizeRgba } from '../public/rgba-picker.js';

test('RGBA 支持数字、百分比及旧十六进制格式，保留透明颜色并限制通道范围', () => {
  assert.equal(normalizeRgba('rgba(255, 128, 0, 0)'), 'rgba(255, 128, 0, 0)');
  assert.equal(normalizeRgba('rgba(100%, 50%, 0%, 25%)'), 'rgba(255, 128, 0, 0.25)');
  assert.equal(normalizeRgba('#fff8'), 'rgba(255, 255, 255, 0.533)');
  assert.equal(normalizeRgba('#11223380'), 'rgba(17, 34, 51, 0.502)');
  assert.equal(normalizeRgba('rgba(999,-10,1.4,2)'), 'rgba(255, 0, 1, 1)');
  assert.equal(normalizeRgba('rgb(12,34,56)'), 'rgba(12, 34, 56, 1)');
  for (const invalid of ['url(x)', 'rgba(1,2,3)', 'rgb(1,2,3,1)', 'rgba(1,2,3,NaN)', '', null]) assert.equal(parseRgba(invalid),null);
  assert.equal(normalizeRgba('invalid', 'rgba(0,0,0,0.4)'), 'rgba(0, 0, 0, 0.4)');
});
