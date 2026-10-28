import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomAudio } from '../public/audio.js';
import { loadMix, saveMix } from '../public/mix.js';

test('两台设备独立混音，调整增益保留播放音源与时间轴', () => {
  const devices = [new RoomAudio(() => 1000), new RoomAudio(() => 1000)];
  const gains = devices.map(audio => {
    const values = {};
    audio.context = { currentTime: 5 };
    audio.gains = Object.fromEntries(['instrumental', 'vocal'].map(type => [type, { gain: { setTargetAtTime: value => { values[type] = value; } } }]));
    audio.master = { gain: { setTargetAtTime: value => { values.master = value; } } };
    return values;
  });
  const source = { stop: () => assert.fail('混音变化不应停止播放') };
  devices[0].sources = [source]; devices[0].anchor = { position: 3, audioTime: 1 };
  devices[0].mix.vocal = 0.3;
  devices.forEach(audio => audio.applyMix());
  assert.deepEqual(gains[0], { instrumental: 1, vocal: 0.3, master: 0.75 });
  assert.deepEqual(gains[1], { instrumental: 1, vocal: 1, master: 0.75 });
  assert.equal(devices[0].sources[0], source);
  assert.deepEqual(devices[0].anchor, { position: 3, audioTime: 1 });
});
test('混音保存在各自浏览器，损坏/受限存储可回退，数值限制在有效增益范围', () => {
  const store = () => { const map = new Map(); return { getItem: key => map.get(key) || null, setItem: (key, value) => map.set(key, value) }; };
  const first = store(), second = store();
  saveMix(first, { instrumental: 1, vocal: 0 });
  assert.deepEqual(loadMix(first), { instrumental: 1, vocal: 0 });
  assert.deepEqual(loadMix(second), { instrumental: 1, vocal: 1 });
  saveMix(first, { instrumental: -2, vocal: 10 });
  assert.deepEqual(loadMix(first), { instrumental: 0, vocal: 1 });
  assert.deepEqual(loadMix({ getItem: () => 'broken-json' }), { instrumental: 1, vocal: 1 });
  const blocked = { getItem: () => { throw new Error(); }, setItem: () => { throw new Error(); } };
  assert.deepEqual(loadMix(blocked), { instrumental: 1, vocal: 1 });
  assert.doesNotThrow(() => saveMix(blocked, { instrumental: 1, vocal: 0 }));
});
