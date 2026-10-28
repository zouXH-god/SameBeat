import test from 'node:test';
import assert from 'node:assert/strict';
import { visualLyricTime, normalizeLyricLead } from '../shared/lyric-time.js';
import { buildMv, groupAt } from '../shared/mv.js';

test('视觉提前量让歌词和换组提前，保留房间偏移且可关闭', () => {
  const groups = buildMv([{ timeMs: 0, text: '第一行' }, { timeMs: 1000, text: '第二行', endMs: 2000 }, { timeMs: 2000, text: '下一组' }], text => [text], 4000);
  assert.equal(groupAt(groups, visualLyricTime(1799, 0)), 0);
  assert.equal(groupAt(groups, visualLyricTime(1800, 0)), 1);
  assert.equal(groupAt(groups, visualLyricTime(1800, 0, 0)), 0);
  assert.equal(groupAt(groups, visualLyricTime(2199, 0, -200)), 0);
  assert.equal(groupAt(groups, visualLyricTime(2200, 0, -200)), 1);
  assert.equal(visualLyricTime(1800, 100, 200), 1900);
  assert.equal(visualLyricTime(1800, -100, 200), 2100);
  assert.equal(normalizeLyricLead(NaN), 200);
  assert.equal(normalizeLyricLead(-50), -50);
  assert.equal(normalizeLyricLead(-2000), -1000);
  assert.equal(normalizeLyricLead(2000), 1000);
});
