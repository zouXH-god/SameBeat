import { activeTimeline, positionAt } from '../shared/timeline.js';

export class RoomAudio {
  constructor(serverNow) {
    this.serverNow = serverNow;
    this.buffers = new Map(); this.sources = []; this.rate = 1; this.anchor = null;
    this.localVolume = 0.75; this.enabled = false;
    this.mix = { instrumental: 1, vocal: 1 };
  }
  initialize() {
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: 'interactive' });
      this.master = this.context.createGain();
      const limiter = this.context.createDynamicsCompressor();
      this.master.connect(limiter); limiter.connect(this.context.destination);
      this.gains = Object.fromEntries(['instrumental', 'vocal'].map(type => {
        const gain = this.context.createGain(); gain.connect(this.master); return [type, gain];
      }));
      this.master.gain.value = this.localVolume;
    }
  }
  async enable() {
    this.initialize();
    await this.context.resume(); this.enabled = this.context.state === 'running';
  }
  async decode(bytes) { this.initialize(); return this.context.decodeAudioData(bytes); }
  applyMix() {
    if (!this.context) return;
    const time = this.context.currentTime;
    for (const type of ['instrumental', 'vocal']) this.gains[type].gain.setTargetAtTime(this.mix[type], time, 0.02);
    this.master.gain.setTargetAtTime(this.localVolume, time, 0.02);
  }
  stop() {
    for (const source of this.sources) { try { source.stop(); } catch {} }
    this.sources = []; this.anchor = null; this.rate = 1;
  }
  outputDelay() { return (this.context?.outputLatency || 0) + (this.context?.baseLatency || 0); }
  sync(room) {
    this.applyMix();
    if (!this.enabled || this.context.state !== 'running') { this.stop(); return; }
    const timestamp = this.serverNow();
    const current = activeTimeline(room.playback, timestamp);
    const pending = room.playback.pending && room.playback.pending.at > timestamp ? room.playback.pending : null;
    // Keep the current sources audible until a future command takes effect.
    // Volume/member broadcasts never enter this method; repeated commands replace stop times.
    if (pending && current.status === 'PLAYING' && this.anchor?.startsAt <= timestamp && this.liveSignature === this.signature(room, current)) {
      const end = Math.max(this.context.currentTime + 0.005, this.context.currentTime + (pending.at - timestamp) / 1000 - this.outputDelay());
      for (const source of this.sources) { try { source.stop(end); } catch {} }
      if (pending.next.status === 'PLAYING') this.segment(room, pending.next, pending.at);
      return;
    }
    this.stop();
    if (current.status === 'PLAYING') this.segment(room, current, timestamp + 100, pending?.at);
    if (pending?.next.status === 'PLAYING') this.segment(room, pending.next, pending.at);
  }
  signature(room, timeline) {
    return JSON.stringify([timeline.status, timeline.positionMs, timeline.startServerTime, ...['instrumental', 'vocal'].map(type => [room.tracks[type]?.version, room.tracks[type]?.offsetMs])]);
  }
  segment(room, timeline, serverStart, serverEnd) {
    if (serverEnd && serverStart >= serverEnd) return;
    const now = this.serverNow();
    const targetAudioTime = this.context.currentTime + (serverStart - now) / 1000 - this.outputDelay();
    const when = Math.max(this.context.currentTime + 0.015, targetAudioTime);
    const audibleServerStart = now + (when - this.context.currentTime + this.outputDelay()) * 1000;
    const roomPosition = positionAt(timeline, audibleServerStart, room.durationMs) / 1000;
    this.rate = 1; this.liveSignature = this.signature(room, timeline);
    this.anchor = { audioTime: when, position: roomPosition, startsAt: audibleServerStart };
    for (const type of ['instrumental', 'vocal']) {
      const track = room.tracks[type]; const buffer = track && this.buffers.get(track.version);
      if (!buffer) continue;
      const offset = roomPosition - track.offsetMs / 1000;
      if (offset >= buffer.duration) continue;
      const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.gains[type]);
      const start = when + Math.max(0, -offset);
      const end = serverEnd ? this.context.currentTime + (serverEnd - now) / 1000 - this.outputDelay() : Infinity;
      if (start >= end) continue;
      source.start(start, Math.max(0, offset));
      if (Number.isFinite(end)) source.stop(Math.max(start + 0.001, end));
      this.sources.push(source);
    }
  }
  measure(room) {
    if (!this.anchor || !this.enabled || this.context.state !== 'running' || room.playback.pending?.at > this.serverNow()) return null;
    const audibleTime = this.context.currentTime - this.outputDelay();
    if (audibleTime < this.anchor.audioTime) return null;
    const actual = (this.anchor.position + (audibleTime - this.anchor.audioTime) * this.rate) * 1000;
    const error = actual - positionAt(room.playback, this.serverNow(), room.durationMs);
    if (activeTimeline(room.playback, this.serverNow()).status !== 'PLAYING') return null;
    if (Math.abs(error) > 200) this.sync(room);
    else {
      const nextRate = Math.abs(error) < 10 ? 1 : 1 - Math.max(-0.008, Math.min(0.008, error / 10000));
      // Rebase the position before changing rate; both tracks always receive the same rate.
      this.anchor.position += (this.context.currentTime - this.anchor.audioTime) * this.rate;
      this.anchor.audioTime = this.context.currentTime;
      this.rate = nextRate;
      for (const source of this.sources) source.playbackRate.setValueAtTime(nextRate, this.context.currentTime);
    }
    return error;
  }
}
