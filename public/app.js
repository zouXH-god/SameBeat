import { RoomAudio } from './audio.js';
import { LyricMv } from './mv.js';
import { loadMix, saveMix, normalizeMix } from './mix.js';
import { positionAt, activeTimeline } from '/shared/timeline.js';
import { normalizeLyricLead, DEFAULT_LYRIC_LEAD_MS, visualLyricTime } from '/shared/lyric-time.js';

const $ = id => document.getElementById(id);
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const types = ['instrumental', 'vocal'];
let room = null, socket = null, connectionId = 0, retry = 0, reconnectTimer, syncTimers = [], samples = [], clockOffset = 0, rtt = null, errorMs = null;
let resourceKey = '', audioKey = '', loadGeneration = 0, lyricKey = '', lyricIndex = -2, toastTimer, seeking = false, intentionalLeave = false;
let clientId = null, mixReportTimer;
const loadStates = { instrumental: '', vocal: '' };
const audio = new RoomAudio(() => performance.now() + clockOffset);
const mv = new LyricMv($('lyric-mv'), toast);
// Wrapped MV controls can have different heights on narrow screens. Keep both
// settings panels below the toolbar without changing the lyric-stage geometry.
new ResizeObserver(([entry]) => {
  $('lyric-mv').style.setProperty('--mv-toolbar-height', `${entry.target.getBoundingClientRect().height}px`);
}).observe(document.querySelector('.mv-toolbar'));
const lyricLeadKey = 'sync-room:lyric-lead-ms';
let lyricLeadMs = DEFAULT_LYRIC_LEAD_MS;
try {
  const saved = localStorage.getItem(lyricLeadKey);
  if (saved !== null) lyricLeadMs = normalizeLyricLead(Number(saved));
} catch {}
for (const id of ['lyric-lead', 'mv-lyric-lead']) {
  $(id).value = lyricLeadMs;
  $(id).onchange = event => {
    lyricLeadMs = normalizeLyricLead(event.target.value === '' ? NaN : Number(event.target.value));
    for (const inputId of ['lyric-lead', 'mv-lyric-lead']) $(inputId).value = lyricLeadMs;
    try { localStorage.setItem(lyricLeadKey, String(lyricLeadMs)); } catch {}
  };
}
let mvReturnFocus;
function openMv() {
  if (!room) return;
  mvReturnFocus = document.activeElement;
  mv.visible = true; $('lyric-mv').hidden = false; document.body.classList.add('mv-opened');
  mv.background.setVisible(true);
  document.querySelector('main').inert = true; document.querySelector('.topbar').inert = true;
  mv.setLyrics(room.lyrics, room.durationMs); mv.fit(); $('mv-close').focus();
}
async function closeMv() {
  if (document.fullscreenElement === $('lyric-mv')) await document.exitFullscreen().catch(() => {});
  mv.visible = false; $('lyric-mv').hidden = true; document.body.classList.remove('mv-opened');
  mv.background.setVisible(false);
  mv.typography.showPanel(false);
  document.querySelector('main').inert = false; document.querySelector('.topbar').inert = false; mvReturnFocus?.focus();
}
$('mv-open').onclick = openMv;
$('mv-close').onclick = closeMv;
$('mv-play').onclick = async () => {
  if (!room || !owner()) return;
  if (!audio.enabled) { try { await audio.enable(); audioKey = ''; executeAudio(); reportReady(); } catch { toast('请先启用声音'); return; } }
  if (!types.every(type => !room.tracks[type] || audio.buffers.has(room.tracks[type].version))) { toast('请等待音轨就绪'); return; }
  send({ type: activeTimeline(room.playback, audio.serverNow()).status === 'PLAYING' ? 'PAUSE' : 'PLAY' });
};
$('mv-fullscreen').onclick = async () => {
  try {
    if (document.fullscreenElement === $('lyric-mv')) await document.exitFullscreen();
    else if ($('lyric-mv').requestFullscreen) await $('lyric-mv').requestFullscreen();
    else toast('此浏览器暂不支持全屏，已使用铺满窗口的 MV 模式');
  } catch { toast('浏览器未允许全屏，仍可使用铺满窗口的 MV 模式'); }
};
document.addEventListener('fullscreenchange', () => { $('mv-fullscreen').textContent = document.fullscreenElement ? '⛶ 退出全屏' : '⛶ 全屏'; mv.fit(); });
$('lyric-mv').addEventListener('keydown', event => {
  if (event.key === 'Escape' && !document.fullscreenElement) closeMv();
  if (event.key === 'Tab') {
    const buttons = [...$('lyric-mv').querySelectorAll('button,input,select')].filter(button => !button.disabled && button.getClientRects().length);
    const first = buttons[0], last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
audio.mix = loadMix(localStorage);
function renderMix(force = false) {
  for (const type of types) {
    const gain = $(type + '-gain');
    if (gain) { gain.disabled = false; if (force || document.activeElement !== gain) gain.value = audio.mix[type]; }
    if ($(type + '-value')) $(type + '-value').textContent = Math.round(audio.mix[type] * 100) + '%';
  }
  document.querySelectorAll('[data-preset]').forEach(button => {
    button.disabled = false;
    const [i, v] = button.dataset.preset.split(',').map(Number);
    button.classList.toggle('active', audio.mix.instrumental === i && audio.mix.vocal === v);
  });
}
function setMix(mix, report = true) {
  audio.mix = normalizeMix(mix); audio.applyMix(); saveMix(localStorage, audio.mix); renderMix(!report);
  if (report) {
    clearTimeout(mixReportTimer);
    mixReportTimer = setTimeout(() => { if (room && socket?.readyState === WebSocket.OPEN) send({ type: 'CLIENT_MIX', mix: audio.mix }); }, 80);
  }
}
const token = () => room ? localStorage.getItem('owner:' + room.id) || '' : '';
const owner = () => !!token();
const time = ms => `${Math.floor(ms / 60000).toString().padStart(2, '0')}:${Math.floor(ms / 1000 % 60).toString().padStart(2, '0')}`;
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500); }
function send(message) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); else toast('连接中断，恢复连接后再操作'); }
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { Authorization: 'Bearer ' + token(), ...options.headers } });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '操作失败'); return result;
}
function nickname() { const name = $('nickname').value.trim() || '听众'; localStorage.setItem('nickname', name); return name; }
$('nickname').value = localStorage.getItem('nickname') || '';
$('create-form').onsubmit = async event => {
  event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
  try { nickname(); const result = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name: $('room-name').value.trim() || '今晚，一起听歌' }) }); localStorage.setItem('owner:' + result.room.id, result.ownerToken); await enter(result.room.id); } catch (error) { toast(error.message); } finally { button.disabled = false; }
};
$('join-form').onsubmit = async event => { event.preventDefault(); nickname(); try { await enter($('room-code').value.trim().toUpperCase()); } catch (error) { toast(error.message); } };
async function enter(id) {
  if (!/^[A-Z0-9]{6}$/.test(id)) throw new Error('请输入 6 位房间编号');
  const snapshot = await api('/api/rooms/' + id);
  intentionalLeave = false; room = snapshot.room; resourceKey = ''; audioKey = ''; lyricKey = ''; samples = []; rtt = null; retry = 0;
  history.replaceState(null, '', '?room=' + id);
  $('lobby').hidden = true; $('studio').hidden = false;
  renderTracks(); applyState(snapshot); connect(id);
}
function connect(id) {
  const generation = ++connectionId;
  clientId = null;
  socket?.close(); syncTimers.forEach(clearTimeout); syncTimers = [];
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`); socket = ws;
  $('connection-dot').className = ''; $('connection-text').textContent = retry ? '重新连接中' : '连接中';
  ws.onopen = () => {
    if (generation !== connectionId) return;
    retry = 0; $('connection-dot').className = 'online'; $('connection-text').textContent = '房间已连接';
    send({ type: 'ROOM_JOIN', roomId: id, token: token(), name: localStorage.getItem('nickname') || '听众', mix: audio.mix });
    for (let i = 0; i < 7; i++) syncTimers.push(setTimeout(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'TIME_SYNC', t1: performance.now() })); }, i * 160));
  };
  ws.onmessage = event => {
    if (generation !== connectionId) return;
    const message = JSON.parse(event.data);
    if (message.type === 'ROOM_JOINED') clientId = message.clientId;
    else if (message.type === 'MIX_OVERRIDE') { clearTimeout(mixReportTimer); setMix(message.mix, false); toast('房主已调整你的混音配置，你仍可自行修改'); }
    else if (message.type === 'ROOM_STATE') { applyState(message); if (audio.enabled) reportReady(); }
    else if (message.type === 'TIME_SYNC') {
      const t4 = performance.now(); const delay = (t4 - message.t1) - (message.t3 - message.t2);
      if (delay < 0 || delay > 10000) return;
      samples.push({ rtt: delay, offset: ((message.t2 - message.t1) + (message.t3 - t4)) / 2 }); samples = samples.slice(-30);
      const best = [...samples].sort((a, b) => a.rtt - b.rtt).slice(0, 5);
      const previous = clockOffset; clockOffset = best.reduce((sum, item) => sum + item.offset, 0) / best.length;
      rtt = best[0].rtt; updateMetrics();
      if (samples.length === 1 || Math.abs(previous - clockOffset) > 30) { audioKey = ''; executeAudio(); }
      executeAudio(); reportReady();
    } else if (message.type === 'ERROR') toast(message.error);
    else if (message.type === 'ROOM_CLOSED') { leave(); toast('房主已关闭音乐室'); }
  };
  ws.onclose = () => {
    if (generation !== connectionId || intentionalLeave) return;
    $('connection-dot').className = ''; $('connection-text').textContent = '离线 · 正在重连';
    reconnectTimer = setTimeout(() => connect(id), Math.min(1000 * 2 ** retry++, 15000));
  };
  ws.onerror = () => {};
}
let readyKey = '';
function reportReady() {
  if (!room || socket?.readyState !== WebSocket.OPEN) return;
  const versions = Object.fromEntries(types.map(t => [t, room.tracks[t]?.version || null]));
  const ready = audio.enabled && audio.context?.state === 'running' && samples.length >= 3 && types.every(t => !room.tracks[t] || audio.buffers.has(room.tracks[t].version));
  const key = connectionId + JSON.stringify({ ready, versions });
  if (readyKey === key) return; readyKey = key;
  send({ type: 'TRACK_READY', ready, versions });
}
function applyState(snapshot) {
  if (room && snapshot.room.revision < room.revision) return;
  room = snapshot.room;
  if (mv.visible) mv.setLyrics(room.lyrics, room.durationMs);
  $('room-title').textContent = room.name; document.title = `${room.name} · 同频`;
  $('room-id').textContent = '# ' + room.id; $('role-label').textContent = owner() ? '房主' : '听众';
  $('close-room').hidden = !owner(); $('lyric-upload-label').hidden = !owner(); $('lyric-offset').disabled = !owner();
  $('lyric-offset').value = room.lyricOffsetMs;
  $('song-title').textContent = (room.tracks.instrumental || room.tracks.vocal)?.name.replace(/\.[^.]+$/, '') || '等待第一首音乐';
  const loaded = types.filter(t => room.tracks[t]);
  $('song-subtitle').textContent = loaded.length ? loaded.map(t => t === 'instrumental' ? '伴奏音轨' : '人声音轨').join(' + ') + ' · 共享房间时间轴' : '上传伴奏或人声，开启共同的聆听时刻';
  $('progress').max = Math.max(1, room.durationMs); $('progress').disabled = !owner() || !room.durationMs;
  $('duration').textContent = time(room.durationMs); $('stop').disabled = !owner();
  renderMix();
  for (const type of types) {
    const track = room.tracks[type]; const upload = $(type + '-upload'); upload.disabled = !owner(); upload.parentElement.hidden = !owner();
    $(type + '-name').textContent = track?.name || '尚未上传音轨';
    const offset = $(type + '-offset'); offset.disabled = !owner() || !track; if (document.activeElement !== offset) offset.value = track?.offsetMs || 0;
  }
  $('lyric-name').textContent = room.lyricName || '尚未上传歌词';
  const nextLyricKey = JSON.stringify(room.lyrics);
  if (nextLyricKey !== lyricKey) {
    lyricKey = nextLyricKey; lyricIndex = -2;
    if (room.lyrics.length) $('lyrics').innerHTML = room.lyrics.map((line, index) => `<div class="lyric-line" data-line="${index}">${escape(line.text || '♪')}</div>`).join('');
    else $('lyrics').innerHTML = '<div class="empty-lyrics"><img src="/assets/waiting.webp" width="320" height="320" alt="" loading="lazy"><p>让文字跟上旋律</p><small>上传 LRC 歌词后，<br>会随房间时间轴自动滚动。</small></div>';
  }
  const members = snapshot.members || [];
  $('member-count').textContent = `${members.length} 人在线`; $('ready-count').textContent = `${members.filter(m => m.ready).length} / ${members.length} 已就绪`;
  renderMembers(members);
  $('revision').textContent = 'v' + room.revision;
  const nextKey = types.map(t => room.tracks[t]?.version || '').join(':');
  if (nextKey !== resourceKey) { resourceKey = nextKey; loadResources(); }
  audio.applyMix(); executeAudio();
}
function renderMembers(members) {
  const container = $('members');
  const ids = new Set(members.map(member => member.clientId));
  for (const card of container.children) if (!ids.has(card.dataset.member)) card.remove();
  for (const member of members) {
    let card = container.querySelector(`[data-member="${member.clientId}"]`);
    if (!card) {
      card = document.createElement('div'); card.className = 'member-card'; card.dataset.member = member.clientId;
      card.innerHTML = '<div class="member"><span class="avatar"></span><div class="member-info"><strong></strong><small></small></div><span class="member-state"></span></div><div class="member-mix-summary muted"></div><div class="member-mix" hidden><span class="muted">房主调整此设备</span><select aria-label="成员混音预设"><option value="">自定义</option><option value="1,1">原曲混合</option><option value="1,0">纯伴奏</option><option value="1,0.3">半伴唱</option><option value="0,1">人声独奏</option></select>' + types.map(type => `<label>${type === 'instrumental' ? '伴奏' : '人声'}<input type="range" min="0" max="1" step="0.01" data-gain="${type}"><output data-value="${type}"></output></label>`).join('') + '</div>';
      container.append(card);
      const submit = () => {
        const mix = Object.fromEntries(types.map(type => [type, Number(card.querySelector(`[data-gain="${type}"]`).value)]));
        send({ type: 'MEMBER_MIX_UPDATE', clientId: member.clientId, mix });
      };
      for (const type of types) {
        const gain = card.querySelector(`[data-gain="${type}"]`);
        gain.oninput = () => { gain.dataset.editing = 'true'; card.querySelector(`[data-value="${type}"]`).textContent = Math.round(gain.value * 100) + '%'; };
        gain.onchange = () => { gain.dataset.editing = ''; submit(); };
        gain.onblur = () => { gain.dataset.editing = ''; };
      }
      card.querySelector('select').onchange = event => {
        if (!event.target.value) return;
        const values = event.target.value.split(',').map(Number);
        types.forEach((type, i) => { card.querySelector(`[data-gain="${type}"]`).value = values[i]; });
        submit();
      };
    }
    card.querySelector('.avatar').textContent = member.name.slice(0, 1);
    card.querySelector('strong').textContent = member.name + (member.owner ? ' · 房主' : '') + (member.clientId === clientId ? ' · 本机' : '');
    card.querySelector('small').textContent = (member.rttMs === null ? '正在校准时钟' : `RTT ${Math.round(member.rttMs)} ms`) + (member.syncErrorMs === null ? '' : ` · 偏差 ${Math.round(member.syncErrorMs)} ms`);
    const status = card.querySelector('.member-state'); status.classList.toggle('ready', member.ready); status.textContent = member.ready ? '● 已就绪' : '○ 准备中';
    const mix = normalizeMix(member.mix);
    card.querySelector('.member-mix-summary').textContent = `伴奏 ${Math.round(mix.instrumental * 100)}% · 人声 ${Math.round(mix.vocal * 100)}%`;
    card.querySelector('.member-mix').hidden = !owner() || !clientId || member.clientId === clientId;
    for (const type of types) {
      const gain = card.querySelector(`[data-gain="${type}"]`); gain.setAttribute('aria-label', `${member.name}的${type === 'instrumental' ? '伴奏' : '人声'}音量`);
      if (gain.dataset.editing !== 'true') { gain.value = mix[type]; card.querySelector(`[data-value="${type}"]`).textContent = Math.round(mix[type] * 100) + '%'; }
    }
    const preset = card.querySelector('select'); preset.setAttribute('aria-label', `${member.name}的混音预设`);
    preset.value = [...preset.options].some(option => option.value === `${mix.instrumental},${mix.vocal}`) ? `${mix.instrumental},${mix.vocal}` : '';
  }
}
function renderTracks() {
  $('track-list').innerHTML = types.map((type, index) => `<div class="track ${type}"><div class="track-head"><span class="track-icon">${index ? '♩' : '≋'}</span><div class="track-name"><strong>${index ? '人声' : '伴奏'} <span class="muted" id="${type}-state"></span></strong><small id="${type}-name">尚未上传音轨</small></div><label class="upload-small">↑ 上传<input type="file" id="${type}-upload" accept=".mp3,.wav,.m4a,.ogg,.flac,.webm" class="upload-input"></label></div><div class="track-controls"><input id="${type}-gain" type="range" min="0" max="1" step="0.01" value="1" aria-label="${index ? '人声' : '伴奏'}音量"><span class="mono gain-value" id="${type}-value">100%</span><label for="${type}-offset">偏移</label><input class="track-offset mono" id="${type}-offset" type="number" min="-10000" max="10000" step="50" value="0" aria-label="${index ? '人声' : '伴奏'}偏移毫秒"><span>ms</span></div></div>`).join('');
  for (const type of types) {
    $(type + '-upload').onchange = event => uploadTrack(type, event.target);
    $(type + '-gain').oninput = event => setMix({ ...audio.mix, [type]: Number(event.target.value) });
    $(type + '-offset').onchange = event => send({ type: 'OFFSET_UPDATE', track: type, offsetMs: Number(event.target.value) });
  }
}
async function loadResources() {
  const generation = ++loadGeneration; audio.stop(); audioKey = ''; reportReady();
  await Promise.all(types.map(async type => {
    const track = room.tracks[type]; if (!track) { loadStates[type] = ''; return; }
    if (audio.buffers.has(track.version)) { loadStates[type] = '已就绪'; return; }
    try {
      loadStates[type] = '下载中'; $(type + '-state').textContent = '· 下载中';
      const response = await fetch(track.fileUrl); if (!response.ok) throw new Error('音轨下载失败');
      const bytes = await response.arrayBuffer();
      if (generation !== loadGeneration) return;
      loadStates[type] = '解码中'; $(type + '-state').textContent = '· 解码中';
      const buffer = await audio.decode(bytes);
      if (generation !== loadGeneration) return;
      audio.buffers.set(track.version, buffer); loadStates[type] = '已就绪';
    } catch (error) { if (generation === loadGeneration) { loadStates[type] = '加载失败'; toast(`${track.name}：加载失败，可点重新对齐重试`); } }
  }));
  if (generation !== loadGeneration) return;
  // Keep only current resources so replacing large files does not retain every decoded buffer.
  const currentVersions = new Set(types.map(t => room.tracks[t]?.version));
  for (const version of audio.buffers.keys()) if (!currentVersions.has(version)) audio.buffers.delete(version);
  for (const type of types) $(type + '-state').textContent = loadStates[type] ? '· ' + loadStates[type] : '';
  executeAudio(); reportReady();
}
function executeAudio() {
  if (!room || !audio.enabled || samples.length < 3) return;
  const allReady = types.every(t => !room.tracks[t] || audio.buffers.has(room.tracks[t].version));
  if (!allReady) return;
  const key = `${room.playbackRevision}:${resourceKey}:${audio.enabled}`;
  if (key === audioKey) return; audioKey = key; audio.sync(room);
}
async function uploadTrack(type, input) {
  const file = input.files[0]; if (!file) return;
  if (file.size > 100 * 1024 * 1024) { toast('每条音轨不能超过 100 MB'); input.value = ''; return; }
  input.disabled = true; $(type + '-state').textContent = '· 正在处理';
  try {
    const buffer = await audio.decode(await file.arrayBuffer());
    await api(`/api/rooms/${room.id}/tracks/${type}?durationMs=${Math.round(buffer.duration * 1000)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file });
    toast('音轨已上传，房间已暂停并同步新资源');
  } catch (error) { toast('上传失败：' + error.message); $(type + '-state').textContent = '· 上传失败'; } finally { input.disabled = false; input.value = ''; }
}
$('lyric-upload').onchange = async event => {
  const file = event.target.files[0]; if (!file) return;
  try { await api(`/api/rooms/${room.id}/lyrics`, { method: 'POST', headers: { 'X-File-Name': encodeURIComponent(file.name) }, body: file }); toast('歌词已同步到房间'); } catch (error) { toast(error.message); } finally { event.target.value = ''; }
};
$('lyric-offset').onchange = event => send({ type: 'OFFSET_UPDATE', track: 'lyrics', offsetMs: Number(event.target.value) });
$('enable-audio').onclick = async () => { try { await audio.enable(); $('enable-audio').textContent = '✓ 声音已启用'; audioKey = ''; executeAudio(); reportReady(); } catch (error) { toast('无法启用声音：' + error.message); } };
$('play').onclick = () => send({ type: activeTimeline(room.playback, audio.serverNow()).status === 'PLAYING' ? 'PAUSE' : 'PLAY' });
$('stop').onclick = () => send({ type: 'STOP' });
$('resync').onclick = async () => { if (!audio.enabled) await audio.enable(); audioKey = ''; loadResources(); send({ type: 'TIME_SYNC', t1: performance.now() }); toast('正在重新校准并对齐'); };
$('progress').oninput = event => { seeking = true; $('position').textContent = time(Number(event.target.value)); };
$('progress').onchange = event => { seeking = false; send({ type: 'SEEK', positionMs: Number(event.target.value) }); };
$('local-volume').oninput = event => { audio.localVolume = Number(event.target.value); $('local-volume-value').textContent = Math.round(audio.localVolume * 100) + '%'; audio.applyMix(); };
document.querySelectorAll('[data-preset]').forEach(button => { button.onclick = () => { const [instrumental, vocal] = button.dataset.preset.split(',').map(Number); setMix({ instrumental, vocal }); }; });
$('share').onclick = async () => { try { await navigator.clipboard.writeText(location.href); toast('房间链接已复制，发送给朋友即可加入'); } catch { toast(`房间编号：${room.id}，也可复制地址栏链接分享`); } };
function leave() {
  if (mv.visible) closeMv();
  clearTimeout(mixReportTimer); clientId = null; $('members').replaceChildren();
  intentionalLeave = true; connectionId++; clearTimeout(reconnectTimer); syncTimers.forEach(clearTimeout); socket?.close(); audio.stop(); room = null; loadGeneration++; audio.buffers.clear();
  document.body.classList.remove('playing');
  $('studio').hidden = true; $('lobby').hidden = false; $('connection-dot').className = ''; $('connection-text').textContent = '未连接'; history.replaceState(null, '', '/'); document.title = '同频 · 绝对同步音乐室';
}
$('leave').onclick = leave;
$('close-room').onclick = async () => { if (!confirm('关闭音乐室后，所有成员将退出。确定关闭？')) return; try { await api('/api/rooms/' + room.id, { method: 'DELETE' }); leave(); toast('音乐室已关闭'); } catch (error) { toast(error.message); } };
function updateMetrics() {
  $('rtt').innerHTML = `${rtt === null ? '—' : Math.round(rtt)}<small> ms</small>`;
  $('drift').innerHTML = `${errorMs === null ? '—' : Math.round(errorMs)}<small> ms</small>`;
  $('sync-detail').textContent = samples.length < 3 ? '正在校准服务器时钟' : !audio.enabled ? '时钟已校准 · 等待启用声音' : '单调时钟已校准 · 持续对齐';
}
function frame() {
  if (room && samples.length) {
    const now = audio.serverNow(), position = positionAt(room.playback, now, room.durationMs), current = activeTimeline(room.playback, now);
    const scheduled = room.playback.pending?.at > now;
    $('play-status').textContent = scheduled ? '等待统一生效' : ({ PLAYING: '正在播放', PAUSED: '已暂停', STOPPED: '已停止', ENDED: '播放结束' }[current.status]);
    document.body.classList.toggle('playing', current.status === 'PLAYING');
    $('play').textContent = current.status === 'PLAYING' ? 'Ⅱ' : '▶'; $('play').setAttribute('aria-label', current.status === 'PLAYING' ? '暂停' : '播放');
    $('play').disabled = !owner() || !audio.enabled || !room.durationMs || !types.every(t => !room.tracks[t] || audio.buffers.has(room.tracks[t].version));
    if (!seeking) { $('progress').value = position; $('position').textContent = time(position); }
    $('player-note').textContent = !audio.enabled ? '首次聆听需要启用声音，才能加入同步播放。' : audio.context?.state !== 'running' ? '音频已被浏览器挂起，请再次点击启用声音。' : owner() ? '播放控制将在 700 ms 后统一生效；混音比例仅影响此设备。' : '正在跟随房主的播放时间轴，你可以独立调整混音比例和本机音量。';
    const lyricTime = visualLyricTime(position, room.lyricOffsetMs, lyricLeadMs);
    if (mv.visible) {
      mv.update(lyricTime, current.status, room.name);
      $('mv-play').disabled = !owner() || !room.durationMs;
      $('mv-play').textContent = current.status === 'PLAYING' ? 'Ⅱ 暂停' : '▶ 播放';
      $('mv-play').setAttribute('aria-label', current.status === 'PLAYING' ? 'MV 暂停' : 'MV 播放');
    }
    let index = -1;
    for (let i = 0; i < room.lyrics.length && room.lyrics[i].timeMs <= lyricTime; i++) index = i;
    if (index !== lyricIndex) {
      $('lyrics').querySelector('.current')?.classList.remove('current');
      const line = $('lyrics').querySelector(`[data-line="${index}"]`); if (line) { line.classList.add('current'); $('lyrics').scrollTo({ top: line.offsetTop - $('lyrics').offsetTop - $('lyrics').clientHeight / 2 + line.clientHeight / 2, behavior: 'smooth' }); }
      lyricIndex = index;
    }
  }
  requestAnimationFrame(frame);
}
frame();
setInterval(() => { if (room && socket?.readyState === WebSocket.OPEN) send({ type: 'TIME_SYNC', t1: performance.now() }); }, 15000);
setInterval(() => {
  if (!room) return;
  errorMs = audio.measure(room); updateMetrics(); reportReady();
  if (socket?.readyState === WebSocket.OPEN) send({ type: 'CLIENT_STATUS', rttMs: rtt, syncErrorMs: errorMs });
}, 3000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && room) { audioKey = ''; executeAudio(); if (socket?.readyState === WebSocket.OPEN) send({ type: 'TIME_SYNC', t1: performance.now() }); } });
const initialId = new URLSearchParams(location.search).get('room');
if (initialId) enter(initialId.toUpperCase()).catch(error => { toast(error.message); history.replaceState(null, '', '/'); });
