import test from 'node:test';
import assert from 'node:assert/strict';
import { cut } from 'jieba-wasm';
import { buildMv, groupAt, wordProgress, mvTransition, wordTilt } from '../shared/mv.js';
import { parseLrc } from '../shared/lrc.js';

test('真实 jieba 按词编排，文本无丢失、字号有差异且每组最多两行', () => {
  const groups = buildMv([{ timeMs: 0, text: '中华人民共和国武汉市长江大桥' }, { timeMs: 4000, text: '一起听音乐， hello world' }, { timeMs: 8000, text: '再相遇' }], cut, 12000);
  assert.deepEqual(groups[0].rows[0].words.map(word => word.text), ['中华人民共和国', '武汉市', '长江大桥']);
  assert.equal(groups[0].rows[1].words.map(word => word.text).join(''), '一起听音乐， hello world');
  assert.ok(new Set(groups[0].rows[0].words.map(word => word.size)).size > 1);
  assert.deepEqual(groups.map(group => group.rows.length), [2, 1]);
});

test('换组时预览放大接替主歌词，旧歌词缩小退出，暂停和跳转可直接重建', () => {
  const groups = buildMv(Array.from({ length: 5 }, (_, i) => ({ timeMs: i * 2000, text: `歌词${i}` })), cut, 10000);
  assert.deepEqual(groups.map(group => group.rows.length), [2, 2, 1]);
  const before = mvTransition(groups, 3999);
  assert.equal(before[0].role, 'current');
  assert.equal(before[0].scale, 1);
  assert.equal(before[1].role, 'preview');
  assert.equal(before[1].scale, 0.48);
  assert.equal(before[1].opacity, 0.32);
  const beginning = mvTransition(groups, 4000);
  assert.equal(beginning[0].opacity, 1);
  assert.equal(beginning[0].scale, 1);
  assert.equal(beginning[1].index, before[1].index);
  assert.equal(beginning[1].opacity, before[1].opacity);
  assert.equal(beginning[1].scale, before[1].scale);
  assert.equal(beginning[2].opacity, 0);
  const middle = mvTransition(groups, 4300);
  assert.ok(middle[0].scale < 1 && middle[0].opacity < 1);
  assert.ok(middle[1].scale > 0.48 && middle[1].scale < 1);
  assert.deepEqual(mvTransition(groups, 4300), middle);
  const done = mvTransition(groups, 4600);
  assert.equal(done[0].role, 'current');
  assert.equal(done[0].scale, 1);
  assert.equal(done[0].opacity, 1);
  assert.equal(done[1].role, 'preview');
  assert.deepEqual(mvTransition(groups, 4000, true), done);
  assert.deepEqual(mvTransition(groups, 1000), mvTransition(groups, 3999));
  assert.equal(mvTransition(groups, 9000).at(-1).index, 2);
  assert.deepEqual(mvTransition([], 0), []);
});

test('词语倾斜幅度不超过三度，正负错落且暂停、跳转后角度不变', () => {
  const row = buildMv([{timeMs: 2000, text:'让每一个声音在此刻相遇'}], cut, 6000)[0].rows[0];
  const angles = row.words.map((word, i) => wordTilt(word.text, i, row.timeMs));
  assert.ok(angles.every(angle => Math.abs(angle) <= 3));
  assert.ok(angles.some(angle => angle > 0));
  assert.ok(angles.some(angle => angle < 0));
  assert.deepEqual(row.words.map((word, i) => wordTilt(word.text, i, row.timeMs)), angles);
});
test('第二行结束才换组，逐字歌词结束标记能在间奏前换组，跳转可直接定位', () => {
  const groups = buildMv(parseLrc('[00:01]第一行\n[00:04]第[00:05]二行[00:06]\n[00:10]第三行\n[00:14]第四行'), cut, 20000);
  assert.equal(groupAt(groups, 0), 0);
  assert.equal(groupAt(groups, 5999), 0);
  assert.equal(groupAt(groups, 6000), 1);
  assert.equal(groupAt(groups, 16000), 1);
  assert.equal(groupAt(groups, 2000), 0);
  const plain = buildMv(parseLrc('[00:01]第一行\n[00:04]第二行\n[00:10]第三行'), cut, 15000);
  assert.equal(groupAt(plain, 9999), 0);
  assert.equal(groupAt(plain, 10000), 1);
});
test('动画由播放时间推导，暂停保持不变，回退可重置，空歌词可处理', () => {
  const row = buildMv([{ timeMs: 1000, endMs: 5000, text: '一起听音乐' }], cut, 10000)[0].rows[0];
  const word = row.words[0];
  assert.equal(wordProgress(row, word, 0), 0);
  assert.equal(wordProgress(row, word, 6000), 1);
  assert.equal(wordProgress(row, word, 2000), 0.625);
  assert.equal(wordProgress(row, word, 1000), 0);
  assert.equal(groupAt(buildMv([], cut, 0), 0), -1);
});
