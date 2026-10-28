// Cache compressed frames locally; keep only a small decoded window in memory.
export class ReverseFrameCache {
  constructor(video, canvas) {
    this.video = video; this.canvas = canvas;
    this.captureCanvas = document.createElement('canvas');
    this.captureContext = this.captureCanvas.getContext('2d', { alpha: false });
    this.paintCanvas = document.createElement('canvas');
    this.paintContext = this.paintCanvas.getContext('2d', { alpha: false });
    this.context = canvas.getContext('2d', { alpha: false });
    this.generation = 0; this.frames = []; this.bitmaps = new Map();
    this.pending = Promise.resolve(); this.busy = false; this.lastTime = -Infinity;
    window.addEventListener('pagehide', () => this.reset());
  }
  database() {
    if (!this.db) {
      this.dbName = `sync-room-mv-frames-${crypto.randomUUID()}`;
      this.db = new Promise((resolve, reject) => {
        const request = indexedDB.open(this.dbName, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('frames');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return this.db;
  }
  async store(action, key, blob) {
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('frames', action === 'get' ? 'readonly' : 'readwrite');
      const store = transaction.objectStore('frames');
      const request = action === 'get' ? store.get(key) : store.put(blob, key);
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
  }
  capture(time) {
    if (this.busy || this.error || this.complete || this.video.readyState < 2 || time - this.lastTime < 1 / 30 - 0.002) return;
    const generation = this.generation;
    const scale = Math.min(1, 1280 / this.video.videoWidth, 720 / this.video.videoHeight);
    const width = Math.max(1, Math.round(this.video.videoWidth * scale));
    const height = Math.max(1, Math.round(this.video.videoHeight * scale));
    if (this.captureCanvas.width !== width || this.captureCanvas.height !== height) {
      this.captureCanvas.width = width; this.captureCanvas.height = height;
    }
    this.busy = true; this.lastTime = time;
    const previous = this.pending;
    this.pending = (async () => {
      this.captureContext.drawImage(this.video, 0, 0, width, height);
      let blob;
      try {
        blob = await new Promise(resolve => this.captureCanvas.toBlob(resolve, 'image/jpeg', 0.85));
      } finally {
        // Disk writes must not block capturing the following video frame.
        if (generation === this.generation) this.busy = false;
      }
      if (generation !== this.generation) return;
      if (!blob) throw new Error('背景帧缓存失败');
      const index = this.frames.length;
      this.frames.push({ time, width, height });
      await previous;
      if (generation !== this.generation) return;
      await this.store('put', index, blob);
    })().catch(error => {
      if (generation === this.generation) { this.error = error; this.busy = false; }
    });
  }
  async finish() {
    await this.pending;
    this.complete = !this.error && this.frames.length > 1;
    return this.complete;
  }
  async prepare() {
    this.capture(this.video.currentTime);
    await this.pending;
    this.prepared = true;
  }
  frameAt(time) {
    let low = 0, high = this.frames.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (this.frames[mid].time <= time) low = mid; else high = mid - 1;
    }
    // Nearest-frame sampling gives endpoints a half interval on each side of
    // the turn, instead of holding the endpoint for two full frame intervals.
    return low + 1 < this.frames.length && this.frames[low + 1].time - time < time - this.frames[low].time ? low + 1 : low;
  }
  bitmap(index) {
    if (!this.bitmaps.has(index)) {
      const generation = this.generation;
      const promise = this.store('get', index).then(blob => createImageBitmap(blob)).then(bitmap => {
        if (generation !== this.generation || this.bitmaps.get(index) !== promise) { bitmap.close(); return null; }
        return bitmap;
      });
      promise.catch(() => {});
      this.bitmaps.set(index, promise);
    }
    return this.bitmaps.get(index);
  }
  async draw(time, direction = -1) {
    const index = this.frameAt(time), generation = this.generation;
    const last = this.frames.length - 1, period = last * 2;
    const wanted = new Set([index]);
    // Prefetch through the turn as well as along the current direction.
    for (let step = 1; step <= 8 && last > 0; step++) {
      const phase = ((index + direction * step) % period + period) % period;
      wanted.add(phase <= last ? phase : period - phase);
    }
    for (const key of wanted) this.bitmap(key);
    // Pin the displayed frame until its replacement is committed. In
    // particular, never close the current bitmap while awaiting disk/decode.
    for (const [key, promise] of this.bitmaps) {
      if (!wanted.has(key) && key !== this.drawnIndex && key !== 0 && key !== last) {
        this.bitmaps.delete(key); promise.then(bitmap => bitmap?.close()).catch(() => {});
      }
    }
    if (index === this.drawnIndex) return;
    const bitmap = await this.bitmap(index);
    if (!bitmap || generation !== this.generation) return;
    if (this.paintCanvas.width !== bitmap.width || this.paintCanvas.height !== bitmap.height) {
      this.paintCanvas.width = bitmap.width; this.paintCanvas.height = bitmap.height;
    }
    // Prepare on an invisible surface, then replace the visible frame in one
    // synchronous copy. Keep the front surface's backing store stable in loops.
    this.paintContext.drawImage(bitmap, 0, 0);
    if (this.drawnIndex === undefined || this.drawnIndex < 0) {
      this.canvas.width = bitmap.width; this.canvas.height = bitmap.height;
    }
    this.context.drawImage(this.paintCanvas, 0, 0, this.canvas.width, this.canvas.height);
    this.drawnIndex = index;
    this.canvas.hidden = false;
  }
  reset() {
    this.generation++; this.frames = []; this.lastTime = -Infinity;
    this.drawnIndex = -1;
    this.busy = false; this.error = null; this.complete = false;
    this.prepared = false;
    this.pending = Promise.resolve(); this.canvas.hidden = true;
    for (const promise of this.bitmaps.values()) promise.then(bitmap => bitmap?.close()).catch(() => {});
    this.bitmaps.clear();
    if (this.db) {
      const name = this.dbName;
      this.db.then(db => { db.close(); indexedDB.deleteDatabase(name); }).catch(() => {});
      this.db = null;
    }
  }
}

export class MvVideoLoop {
  constructor(video, onError, schedule = callback => requestAnimationFrame(callback), cancel = id => cancelAnimationFrame(id), cache = null) {
    this.video = video; this.onError = onError; this.schedule = schedule; this.cancel = cancel;
    this.cache = cache; this.enabled = false; this.active = false; this.reverse = false;
    this.frame = null; this.captureFrame = null; this.revision = 0;
    video.addEventListener('loadeddata', () => {
      if (this.active && this.enabled && !this.reverse) this.update(true);
    });
    video.addEventListener('seeked', () => {
      if (this.active && this.enabled && !this.reverse && this.cache?.prepare && !this.cache.prepared) this.update(true);
    });
    video.addEventListener('ended', async () => {
      if (!this.enabled || !this.active || !Number.isFinite(video.duration) || video.duration <= 0) return;
      const revision = this.revision;
      if (this.cache && !await this.cache.finish() && revision === this.revision) this.onError('无法缓存视频画面，倒放将使用兼容模式，可能不够流畅');
      if (revision !== this.revision || !this.enabled || !this.active) return;
      this.reverse = true;
      const start = this.cache?.frames?.[0]?.time ?? 0;
      const end = this.cache?.frames?.at(-1)?.time ?? video.duration;
      this.phase = end - start; this.position = end; this.update(true);
    });
  }
  setEnabled(enabled) {
    if (this.enabled !== enabled) {
      this.revision++;
      if (!enabled && (this.reverse || this.cache?.complete)) this.video.currentTime = this.position ?? 0;
      this.reverse = false; this.phase = 0; this.cache?.reset();
      // Cover the entire reverse sequence on the first forward pass.
      if (enabled && this.video.readyState >= 1) this.video.currentTime = 0;
    }
    this.enabled = enabled; this.video.loop = !enabled;
  }
  reset() {
    this.revision++; this.reverse = false; this.phase = 0; this.update(false); this.cache?.reset();
  }
  stopCapture() {
    if (this.captureFrame !== null) this.video.cancelVideoFrameCallback?.(this.captureFrame);
    this.captureFrame = null;
  }
  startCapture() {
    if (!this.cache || !this.enabled || this.cache.complete || !this.video.requestVideoFrameCallback || this.captureFrame !== null) return;
    this.captureFrame = this.video.requestVideoFrameCallback((now, metadata) => {
      this.captureFrame = null;
      if (!this.active || this.reverse || !this.enabled) return;
      this.cache.capture(metadata.mediaTime); this.startCapture();
    });
  }
  update(active) {
    if (this.frame !== null) this.cancel(this.frame);
    this.frame = null; this.active = active;
    if (!active) { this.stopCapture(); this.video.pause(); return; }
    if (this.enabled && (this.cache?.complete || this.reverse)) {
      this.stopCapture(); this.video.pause();
      this.origin = null; this.startTime = this.position; this.startPhase = this.phase; this.lastSeek = -Infinity;
      this.frame = this.schedule(now => this.tick(now));
    } else {
      if (this.cache) this.cache.canvas.hidden = true;
      if (this.enabled && this.cache?.prepare && !this.cache.prepared) {
        // Warm up frame capture before the clock starts so JPEG/IDB startup
        // does not drop the first few frames and lengthen the first endpoint.
        this.video.preload = 'auto';
        if (this.video.readyState < 2 || this.preparing?.revision === this.revision) return;
        this.video.pause();
        const preparation = { revision: this.revision }; this.preparing = preparation;
        this.cache.prepare().finally(() => {
          if (this.preparing === preparation) this.preparing = null;
          if (preparation.revision === this.revision) this.update(this.active);
        });
        return;
      }
      this.startCapture(); this.video.muted = true;
      this.video.play().catch(error => {
        if (this.active && error.name !== 'AbortError') this.onError('视频背景暂未开始播放，请重新打开 MV 或重新选择视频');
      });
    }
  }
  tick(now) {
    this.frame = null;
    if (!this.active || !this.enabled) return;
    this.origin ??= now;
    if (this.cache?.complete) {
      const start = this.cache.frames?.[0]?.time ?? 0;
      const end = this.cache.frames?.at(-1)?.time ?? this.video.duration;
      const span = end - start;
      if (!(span > 0)) return;
      // One continuous clock drives both directions. Modulo preserves overflow
      // at each turn, rather than pausing or restarting a player at the endpoint.
      this.phase = (this.startPhase + (now - this.origin) / 1000) % (span * 2);
      this.reverse = this.phase >= span;
      this.position = start + (this.reverse ? span * 2 - this.phase : this.phase);
      if (!this.painting) {
        this.painting = true;
        const revision = this.revision;
        this.cache.draw(this.position, this.reverse ? -1 : 1).catch(() => {
          if (revision === this.revision) {
            this.cache.complete = false;
            this.cache.canvas.hidden = true;
            this.onError('视频帧读取失败，已切换兼容播放');
            this.video.currentTime = this.position;
            this.update(this.active);
          }
        }).finally(() => {
          this.painting = false;
          if (!this.cache.complete && !this.reverse) this.cache.canvas.hidden = true;
        });
      }
    } else {
      if (!this.reverse) return;
      this.position = Math.max(0, this.startTime - (now - this.origin) / 1000);
      if (this.position <= 0) {
        this.reverse = false; this.video.currentTime = 0; this.update(true); return;
      }
      if (!this.video.seeking && now - this.lastSeek >= 1000 / 30) {
        this.video.currentTime = this.position; this.lastSeek = now;
      }
    }
    if (this.frame === null) this.frame = this.schedule(time => this.tick(time));
  }
}
