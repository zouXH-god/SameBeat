import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, createReadStream, statSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { WebSocketServer, WebSocket } from 'ws';
import { positionAt, schedule, activeTimeline } from '../shared/timeline.js';
import { parseLrc } from '../shared/lrc.js';
import { normalizeMix, validMix } from '../shared/mix.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const data = process.env.DATA_DIR || path.join(root, 'data');
mkdirSync(path.join(data, 'uploads'), { recursive: true });
const database = path.join(data, 'rooms.json');
const rooms = new Map(existsSync(database) ? JSON.parse(readFileSync(database, 'utf8')).map(r => [r.id, r]) : []);
const epoch = Date.now() - performance.now();
const now = () => epoch + performance.now();
const clients = new Map();
for (const room of rooms.values()) {
  delete room.volumes;
  room.playback = { status: 'PAUSED', positionMs: positionAt(room.playback, now(), room.durationMs), startServerTime: 0 };
  room.revision++;
  room.playbackRevision++;
}
function persist() {
  writeFileSync(database + '.tmp', JSON.stringify([...rooms.values()]));
  renameSync(database + '.tmp', database);
}
function isOwner(room, token = '') {
  const a = Buffer.from(room.ownerToken), b = Buffer.from(String(token));
  return a.length === b.length && timingSafeEqual(a, b);
}
function state(room) {
  const { ownerToken, ...safe } = room;
  return { type: 'ROOM_STATE', room: safe, members: [...clients.values()].filter(c => c.roomId === room.id).map(({ socket, token, roomId, ...m }) => ({ ...m, owner: isOwner(room, token) })), serverNow: now() };
}
function send(socket, message) { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
function broadcast(room) { const message = state(room); for (const c of clients.values()) if (c.roomId === room.id) send(c.socket, message); }
function change(room, playback = false) { room.revision++; if (playback) room.playbackRevision++; persist(); broadcast(room); }
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
async function body(req, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error('文件过大'), { status: 413 }); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.webm': 'audio/webm' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/rooms' && req.method === 'POST') {
      if (rooms.size >= 1000) return json(res, 503, { error: '房间数量已达上限' });
      const input = JSON.parse((await body(req, 4096)).toString() || '{}');
      let id; do { id = randomBytes(4).toString('hex').slice(0, 6).toUpperCase(); } while (rooms.has(id));
      const room = { id, name: String(input.name || '一起听音乐').slice(0, 60), ownerToken: randomBytes(32).toString('hex'), createdAt: now(), revision: 1, playbackRevision: 1, durationMs: 0, tracks: { instrumental: null, vocal: null }, lyrics: [], lyricName: '', lyricOffsetMs: 0, playback: { status: 'STOPPED', positionMs: 0, startServerTime: 0 } };
      rooms.set(id, room); persist(); return json(res, 201, { room: state(room).room, ownerToken: room.ownerToken });
    }
    const match = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})(?:\/(tracks\/(instrumental|vocal)|lyrics))?$/);
    if (match) {
      const room = rooms.get(match[1]);
      if (!room) return json(res, 404, { error: '房间不存在或已关闭' });
      if (req.method === 'GET' && !match[2]) return json(res, 200, state(room));
      if (!isOwner(room, req.headers.authorization?.replace(/^Bearer /, ''))) return json(res, 403, { error: '仅房主可以操作' });
      if (req.method === 'DELETE' && !match[2]) {
        for (const c of clients.values()) if (c.roomId === room.id) { send(c.socket, { type: 'ROOM_CLOSED' }); c.socket.close(); }
        rooms.delete(room.id); persist();
        for (const track of Object.values(room.tracks)) if (track) try { unlinkSync(path.join(data, 'uploads', path.basename(track.fileUrl))); } catch {}
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && match[2]) {
        const name = decodeURIComponent(req.headers['x-file-name'] || '未命名文件').slice(0, 180);
        if (match[2] === 'lyrics') {
          const text = (await body(req, 1024 * 1024)).toString('utf8');
          const lyrics = parseLrc(text); if (!lyrics.length) return json(res, 400, { error: '没有找到有效的 LRC 时间戳' });
          room.lyrics = lyrics; room.lyricName = name; change(room); return json(res, 200, { ok: true });
        }
        const type = match[3], extension = path.extname(name).toLowerCase();
        if (!['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.webm'].includes(extension)) return json(res, 400, { error: '不支持此音频格式' });
        const durationMs = Number(url.searchParams.get('durationMs'));
        if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 4 * 3600000) return json(res, 400, { error: '音频时长无效（最长 4 小时）' });
        const bytes = await body(req, 100 * 1024 * 1024);
        if (!bytes.length) return json(res, 400, { error: '音频文件为空' });
        const filename = randomUUID() + extension;
        writeFileSync(path.join(data, 'uploads', filename), bytes);
        const old = room.tracks[type];
        room.playback = { status: 'PAUSED', positionMs: positionAt(room.playback, now(), room.durationMs), startServerTime: 0 };
        room.tracks[type] = { name, fileUrl: '/uploads/' + filename, version: randomUUID(), durationMs, offsetMs: old?.offsetMs || 0 };
        room.durationMs = Math.max(...Object.values(room.tracks).filter(Boolean).map(t => t.durationMs + t.offsetMs));
        for (const c of clients.values()) if (c.roomId === room.id) c.ready = false;
        change(room, true);
        if (old) try { unlinkSync(path.join(data, 'uploads', path.basename(old.fileUrl))); } catch {}
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { error: '不支持的操作' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: '不支持的操作' });
    let file;
    if (/^\/uploads\/[a-f0-9-]+\.(mp3|wav|m4a|ogg|flac|webm)$/.test(url.pathname)) file = path.join(data, url.pathname);
    // Only flat, explicitly named image files are public. Encoded separators,
    // nested paths and source/prompt documents cannot escape this directory.
    else if (/^\/assets\/[a-z0-9][a-z0-9-]*\.(png|webp|ico)$/.test(url.pathname)) file = path.join(root, 'public/assets', path.basename(url.pathname));
    else if (/^\/vendor\/jieba\/jieba_rs_wasm(?:_bg\.wasm|\.js)$/.test(url.pathname)) file = path.join(root, 'node_modules/jieba-wasm/pkg/web', path.basename(url.pathname));
    else if (/^\/shared\/(timeline|lrc|mix|mv|lyric-time)\.js$/.test(url.pathname)) file = path.join(root, url.pathname);
    else if (['/', '/index.html', '/app.js', '/audio.js', '/mix.js', '/mv.js', '/mv-background.js', '/mv-video-loop.js', '/mv-typography.js', '/rgba-picker.js', '/mv.css', '/style.css', '/theme.css'].includes(url.pathname)) file = path.join(root, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
    if (!file || !existsSync(file)) return json(res, 404, { error: '页面不存在' });
    const size = statSync(file).size;
    const headers = { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes', 'Cache-Control': url.pathname.startsWith('/uploads/') ? 'public, max-age=31536000, immutable' : 'no-cache' };
    let start = 0, end = size - 1, status = 200;
    if (req.headers.range) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!range) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
      if (!range[1]) start = Math.max(0, size - Number(range[2]));
      else { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
      if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
      status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    res.writeHead(status, { ...headers, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    const stream = createReadStream(file, { start, end }); stream.on('error', () => res.destroy()); stream.pipe(res);
  } catch (error) { if (!res.headersSent) json(res, error.status || 400, { error: error.status ? error.message : '请求处理失败' }); else res.destroy(); }
});
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8192 });
wss.on('connection', socket => {
  socket.alive = true; socket.on('pong', () => { socket.alive = true; });
  let member;
  socket.on('message', bytes => {
    try {
      const message = JSON.parse(bytes.toString());
      if (message.type === 'TIME_SYNC') return send(socket, { type: 'TIME_SYNC', t1: message.t1, t2: now(), t3: now() });
      if (message.type === 'ROOM_JOIN' && !member) {
        const room = rooms.get(String(message.roomId)); if (!room) return send(socket, { type: 'ERROR', error: '房间不存在' });
        member = { socket, token: message.token || '', roomId: room.id, clientId: randomUUID(), name: String(message.name || '听众').slice(0, 30), ready: false, rttMs: null, syncErrorMs: null, mix: normalizeMix(message.mix) };
        clients.set(socket, member);
        send(socket, { type: 'ROOM_JOINED', clientId: member.clientId });
        return broadcast(room);
      }
      if (!member) return;
      const room = rooms.get(member.roomId); if (!room) return;
      if (message.type === 'TRACK_READY') {
        member.ready = message.ready === true && ['instrumental', 'vocal'].every(t => (room.tracks[t]?.version || null) === (message.versions?.[t] || null));
        return broadcast(room);
      }
      if (message.type === 'CLIENT_STATUS') { member.rttMs = Number.isFinite(message.rttMs) ? Math.max(0, message.rttMs) : null; member.syncErrorMs = Number.isFinite(message.syncErrorMs) ? message.syncErrorMs : null; return broadcast(room); }
      if (message.type === 'CLIENT_MIX') {
        if (!validMix(message.mix)) throw new Error();
        member.mix = normalizeMix(message.mix); return broadcast(room);
      }
      if (message.type === 'VOLUME_UPDATE') return send(socket, { type: 'ERROR', error: '混音由各设备本地配置，不进行同步，请刷新客户端' });
      if (!isOwner(room, member.token)) return send(socket, { type: 'ERROR', error: '仅房主可以控制房间' });
      if (message.type === 'MEMBER_MIX_UPDATE') {
        if (!validMix(message.mix)) throw new Error();
        const target = [...clients.values()].find(c => c.roomId === room.id && c.clientId === message.clientId && c.socket.readyState === WebSocket.OPEN);
        if (!target) return send(socket, { type: 'ERROR', error: '该成员已离线或不在当前房间' });
        target.mix = normalizeMix(message.mix);
        send(target.socket, { type: 'MIX_OVERRIDE', mix: target.mix });
        return broadcast(room);
      }
      const timestamp = now();
      if (['PLAY', 'PAUSE', 'STOP', 'SEEK'].includes(message.type)) {
        if (message.type === 'PLAY' && (!room.durationMs || !member.ready)) return send(socket, { type: 'ERROR', error: '请先启用声音并等待音轨就绪' });
        if (message.type === 'SEEK' && !Number.isFinite(message.positionMs)) throw new Error();
        room.playback = schedule(room.playback, message.type, timestamp, room.durationMs, message.positionMs); change(room, true);
      } else if (message.type === 'OFFSET_UPDATE') {
        if (!Number.isFinite(message.offsetMs)) throw new Error();
        const offset = Math.max(-10000, Math.min(10000, message.offsetMs));
        if (message.track === 'lyrics') { room.lyricOffsetMs = offset; change(room); }
        else if (room.tracks[message.track]) { room.tracks[message.track].offsetMs = offset; room.durationMs = Math.max(...Object.values(room.tracks).filter(Boolean).map(t => t.durationMs + t.offsetMs)); change(room, true); }
      }
    } catch { send(socket, { type: 'ERROR', error: '消息格式无效' }); }
  });
  socket.on('error', () => {});
  socket.on('close', () => { clients.delete(socket); if (member && rooms.has(member.roomId)) broadcast(rooms.get(member.roomId)); });
});
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) { if (!socket.alive) socket.terminate(); else { socket.alive = false; socket.ping(); } }
  for (const room of rooms.values()) if (activeTimeline(room.playback, now()).status === 'PLAYING' && positionAt(room.playback, now(), room.durationMs) >= room.durationMs) {
    room.playback = { status: 'ENDED', positionMs: room.durationMs, startServerTime: 0 }; change(room, true);
  }
}, 5000);
heartbeat.unref();
const port = Number(process.env.PORT || 3000);
const { values: { host } } = parseArgs({ options: { host: { type: 'string', default: '0.0.0.0' } } });
server.listen(port, host, () => console.log(`绝对同步音乐室 http://localhost:${server.address().port}（监听 ${host}）`));
