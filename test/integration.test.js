import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

test('真实 HTTP / WebSocket：权限、资源版本、预约播放、中途加入与关闭', { timeout: 20000 }, async () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'sync-room-test-'));
  const child = spawn(process.execPath, ['server/index.js'], { cwd: fileURLToPath(new URL('../', import.meta.url)), env: { ...process.env, PORT: '0', DATA_DIR: temp }, stdio: ['ignore', 'pipe', 'pipe'] });
  const sockets = [];
  try {
    const port = await new Promise((resolve, reject) => {
      child.stdout.on('data', chunk => { const match = String(chunk).match(/localhost:(\d+)/); if (match) resolve(Number(match[1])); });
      child.once('error', reject); child.once('exit', code => reject(new Error('服务启动失败 ' + code)));
    });
    const base = 'http://localhost:' + port;
    for (const name of ['mascot', 'forest', 'avatar', 'listening', 'waiting', 'botanical']) {
      const response = await fetch(`${base}/assets/${name}.webp`);
      assert.equal(response.status, 200, `${name} 插画应可加载`);
      assert.equal(response.headers.get('content-type'), 'image/webp');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
    }
    const favicon = await fetch(`${base}/assets/favicon.png`, { method: 'HEAD' });
    assert.equal(favicon.status, 200);
    assert.equal(favicon.headers.get('content-type'), 'image/png');
    assert.ok(Number(favicon.headers.get('content-length')) > 0);
    assert.equal((await favicon.arrayBuffer()).byteLength, 0);
    assert.equal((await fetch(`${base}/theme.css`)).status, 200);
    for (const pathname of ['/assets/missing.webp', '/assets/', '/assets/prompts.json', '/assets/sub/forest.webp', '/assets/%2e%2e%2fserver%2findex.js', '/assets/%2e%2e%5cserver%5cindex.js', '/assets/..%5c..%5cdata%5crooms.json']) {
      assert.equal((await fetch(base + pathname)).status, 404, `${pathname} 不应公开`);
    }
    for (const module of ['mv', 'mv-background', 'mv-video-loop', 'mv-typography', 'rgba-picker']) {
      const response = await fetch(`${base}/${module}.js`);
      assert.equal(response.status, 200, `${module}.js 应可通过 HTTP 加载`);
      assert.match(response.headers.get('content-type'), /^text\/javascript/);
      assert.match(await response.text(), /export /);
    }
    const created = await fetch(base + '/api/rooms', { method: 'POST', body: JSON.stringify({ name: '测试音乐室' }) });
    assert.equal(created.status, 201);
    const { room, ownerToken } = await created.json();
    const getState = async () => (await fetch(base + '/api/rooms/' + room.id)).json();
    assert.equal((await getState()).room.ownerToken, undefined);
    const unauthorized = await fetch(base + `/api/rooms/${room.id}/lyrics`, { method: 'POST', body: '[00:00]test' }); assert.equal(unauthorized.status, 403);
    const headers = { Authorization: 'Bearer ' + ownerToken, 'X-File-Name': encodeURIComponent('测试.wav') };
    const bytes = Buffer.alloc(44 + 16000); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(16000, 40);
    const uploaded = await fetch(base + `/api/rooms/${room.id}/tracks/instrumental?durationMs=1000`, { method: 'POST', headers, body: bytes }); assert.equal(uploaded.status, 200);
    let snapshot = await getState(); const track = snapshot.room.tracks.instrumental;
    const range = await fetch(base + track.fileUrl, { headers: { Range: 'bytes=0-43' } }); assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 44);
    const open = async (token, roomId = room.id) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`); sockets.push(ws);
      const queue = [], waiters = [];
      ws.on('message', bytes => { const message = JSON.parse(bytes); const waiter = waiters.find(w => w.matches(message)); if (waiter) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); } else queue.push(message); });
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      const next = matches => { const index = queue.findIndex(matches); if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]); return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('等待消息超时')), 3000); waiters.push({ matches, resolve: message => { clearTimeout(timer); resolve(message); } }); }); };
      ws.send(JSON.stringify({ type: 'ROOM_JOIN', roomId, token, name: token ? '房主' : '听众' }));
      await next(m => m.type === 'ROOM_STATE');
      const joined = await next(m => m.type === 'ROOM_JOINED');
      return { ws, next, clientId: joined.clientId, has: matches => queue.some(matches), send: m => ws.send(JSON.stringify(m)) };
    };
    const host = await open(ownerToken), guest = await open('');
    guest.send({ type: 'PLAY' }); assert.match((await guest.next(m => m.type === 'ERROR')).error, /房主/);
    host.send({ type: 'TIME_SYNC', t1: 123 }); const clock = await host.next(m => m.type === 'TIME_SYNC'); assert.equal(clock.t1, 123); assert.ok(clock.t3 >= clock.t2);
    host.send({ type: 'TRACK_READY', ready: true, versions: { instrumental: 'old' } });
    await host.next(m => m.type === 'ROOM_STATE' && m.members.find(x => x.owner)?.ready === false);
    host.send({ type: 'PLAY' }); assert.match((await host.next(m => m.type === 'ERROR')).error, /就绪/);
    host.send({ type: 'TRACK_READY', ready: true, versions: { instrumental: track.version, vocal: null } });
    await host.next(m => m.type === 'ROOM_STATE' && m.members.some(x => x.owner && x.ready));
    host.send({ type: 'PLAY' }); const playing = await host.next(m => m.type === 'ROOM_STATE' && m.room.playback.pending?.next.status === 'PLAYING');
    assert.ok(playing.room.playback.pending.at > playing.serverNow + 500);
    const late = await open(''); const lateState = await getState(); assert.deepEqual(lateState.room.playback, playing.room.playback);
    for (const client of [host, guest]) {
      client.send({ type: 'VOLUME_UPDATE', track: 'vocal', volume: 0.3 });
      assert.match((await client.next(m => m.type === 'ERROR')).error, /不进行同步/);
      const unchanged = (await getState()).room;
      assert.equal(unchanged.volumes, undefined);
      assert.equal(unchanged.revision, playing.room.revision);
      assert.equal(unchanged.playbackRevision, playing.room.playbackRevision);
    }
    // Only the room owner can override a connected member, and only that target applies it.
    guest.send({ type: 'MEMBER_MIX_UPDATE', clientId: host.clientId, mix: { instrumental: 0, vocal: 1 } });
    assert.match((await guest.next(m => m.type === 'ERROR')).error, /房主/);
    host.send({ type: 'MEMBER_MIX_UPDATE', clientId: guest.clientId, mix: { instrumental: 1, vocal: 2 } });
    assert.match((await host.next(m => m.type === 'ERROR')).error, /格式/);
    const another = await (await fetch(base + '/api/rooms', { method: 'POST', body: '{}' })).json();
    const outsider = await open('', another.room.id);
    host.send({ type: 'MEMBER_MIX_UPDATE', clientId: outsider.clientId, mix: { instrumental: 0, vocal: 1 } });
    assert.match((await host.next(m => m.type === 'ERROR')).error, /当前房间/);
    host.send({ type: 'MEMBER_MIX_UPDATE', clientId: guest.clientId, mix: { instrumental: 1, vocal: 0.3 } });
    assert.deepEqual((await guest.next(m => m.type === 'MIX_OVERRIDE')).mix, { instrumental: 1, vocal: 0.3 });
    await late.next(m => m.type === 'ROOM_STATE' && m.members.some(member => member.clientId === guest.clientId && member.mix.vocal === 0.3));
    assert.equal(host.has(m => m.type === 'MIX_OVERRIDE'), false);
    assert.equal(late.has(m => m.type === 'MIX_OVERRIDE'), false);
    assert.equal(outsider.has(m => m.type === 'MIX_OVERRIDE'), false);
    snapshot = await getState();
    assert.equal(snapshot.room.revision, playing.room.revision);
    assert.equal(snapshot.room.playbackRevision, playing.room.playbackRevision);
    assert.equal(snapshot.members.find(m => m.clientId === late.clientId).mix.vocal, 1);
    guest.send({ type: 'CLIENT_MIX', mix: { instrumental: 0.4, vocal: 0.8 } });
    await host.next(m => m.type === 'ROOM_STATE' && m.members.some(member => member.clientId === guest.clientId && member.mix.vocal === 0.8));
    assert.equal((await fetch(base + `/api/rooms/${room.id}/lyrics`, { method: 'POST', headers, body: '[00:00.00]一起听' })).status, 200);
    snapshot = await getState(); assert.equal(snapshot.room.lyrics[0].text, '一起听');
    host.send({ type: 'PAUSE' }); await host.next(m => m.type === 'ROOM_STATE' && m.room.playback.pending?.next.status === 'PAUSED');
    const closed = late.next(m => m.type === 'ROOM_CLOSED');
    assert.equal((await fetch(base + '/api/rooms/' + room.id, { method: 'DELETE', headers })).status, 200); await closed;
    assert.equal((await fetch(base + '/api/rooms/' + room.id)).status, 404);
  } finally {
    for (const socket of sockets) socket.terminate();
    child.kill(); await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    if (path.resolve(temp).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(temp).startsWith('sync-room-test-')) rmSync(temp, { recursive: true, force: true });
  }
});
