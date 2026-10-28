import { RgbaPicker, normalizeRgba, legacyRgba } from './rgba-picker.js';
import { MvVideoLoop, ReverseFrameCache } from './mv-video-loop.js';
const storageKey = 'sync-room:mv-background';
const defaults = { type: 'color', color: 'rgba(0, 0, 0, 1)', overlayColor: 'rgba(0, 0, 0, 0.35)', pingPong: false };

export function normalizeBackground(value) {
  return {
    type: ['color', 'image', 'video'].includes(value?.type) ? value.type : defaults.type,
    pingPong: value?.pingPong === true,
    color: normalizeRgba(value?.color, defaults.color),
    overlayColor: legacyRgba(value?.overlayColor, defaults.overlayColor, value?.overlayColor === undefined && Number.isFinite(value?.dim) ? Math.max(0, Math.min(0.8, value.dim)) : undefined),
  };
}

let database;
function mediaStore(action, value) {
  database ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('sync-room-mv-background', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('media');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database.then(db => new Promise((resolve, reject) => {
    const transaction = db.transaction('media', action === 'get' ? 'readonly' : 'readwrite');
    const request = transaction.objectStore('media')[action](...(action === 'put' ? [value, 'background'] : ['background']));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = transaction.onabort = () => reject(transaction.error);
  }));
}

export class MvBackground {
  constructor(element, notify) {
    this.notify = notify; this.visible = false; this.revision = 0;
    const find = selector => element.querySelector(selector);
    this.layer = find('.mv-background'); this.image = find('.mv-background img'); this.video = find('.mv-background video');
    this.panel = find('#mv-background-settings'); this.toggle = find('#mv-background-toggle');
    this.type = find('#mv-background-type'); this.colorRoot = find('#mv-background-color');
    this.file = find('#mv-background-file'); this.fileLabel = find('.mv-background-file'); this.name = find('#mv-background-name');
    this.pingPong = find('#mv-background-ping-pong'); this.videoOptions = find('.mv-background-video-options');
    const reverseCanvas = document.createElement('canvas'); reverseCanvas.hidden = true;
    this.video.after(reverseCanvas);
    this.videoLoop = new MvVideoLoop(this.video, message => this.notify(message), undefined, undefined, new ReverseFrameCache(this.video, reverseCanvas));
    let saved;
    try { saved = JSON.parse(localStorage.getItem(storageKey)); } catch {}
    this.settings = normalizeBackground(saved);
    this.color = new RgbaPicker(this.colorRoot, this.settings.color, color => { this.settings.color = color; this.save(); this.render(); });
    this.overlay = new RgbaPicker(find('#mv-background-overlay'), this.settings.overlayColor, color => { this.settings.overlayColor = color; this.save(); this.render(); });
    this.toggle.onclick = () => this.showPanel(this.panel.hidden);
    find('#mv-background-done').onclick = () => { this.showPanel(false); this.toggle.focus(); };
    this.panel.onkeydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.showPanel(false); this.toggle.focus(); }
    };
    document.addEventListener('visibilitychange', () => this.playVideo());
    this.type.onchange = () => { this.revision++; this.settings.type = this.type.value; this.save(); this.render(); };
    this.file.onchange = () => this.chooseFile();
    this.pingPong.onchange = () => { this.settings.pingPong = this.pingPong.checked; this.save(); this.render(); };
    find('#mv-background-reset').onclick = () => {
      this.revision++; this.asset = null; this.settings = { ...defaults }; this.save(); this.render();
      mediaStore('delete').catch(() => this.notify('背景已重置，但无法清除本机保存的媒体'));
    };
    this.render();
    mediaStore('get').then(asset => {
      if (!this.revision && asset?.blob instanceof Blob && ['image', 'video'].includes(asset.type)) { this.asset = asset; this.render(); }
    }).catch(() => {});
    this.image.onerror = this.video.onerror = event => {
      if (!this.asset || event.target.getAttribute('src') !== this.url) return;
      this.asset = null; this.settings.type = 'color'; this.save(); this.render();
      mediaStore('delete').catch(() => {});
      this.notify('无法显示背景，请选择浏览器支持的图片或视频格式');
    };
  }
  save() {
    try { localStorage.setItem(storageKey, JSON.stringify(this.settings)); } catch {}
  }
  showPanel(show) {
    if (show) this.panel.dispatchEvent(new CustomEvent('mv-settings-open', { bubbles: true }));
    this.panel.hidden = !show; this.toggle.setAttribute('aria-expanded', String(show));
    if (show) this.type.focus();
  }
  setVisible(visible) {
    this.visible = visible;
    if (!visible) this.showPanel(false);
    this.playVideo();
  }
  playVideo() {
    this.videoLoop.update(this.visible && !this.video.hidden && !document.hidden);
  }
  render() {
    const { type, color, overlayColor } = this.settings;
    this.type.value = type; this.color.set(color); this.overlay.set(overlayColor);
    this.layer.style.backgroundColor = color; this.layer.style.setProperty('--mv-background-overlay', overlayColor);
    this.colorRoot.hidden = type !== 'color'; this.fileLabel.hidden = type === 'color';
    this.videoOptions.hidden = type !== 'video'; this.pingPong.checked = this.settings.pingPong;
    this.videoLoop.setEnabled(this.settings.pingPong);
    this.file.accept = type === 'video' ? 'video/*' : 'image/*';
    this.name.textContent = type === 'color' ? '设置仅影响本机' : this.asset?.type === type ? this.asset.name : `请选择${type === 'video' ? '视频' : '图片'} · 仅在本机使用`;
    const asset = type !== 'color' && this.asset?.type === type ? this.asset : null;
    if (asset !== this.displayedAsset) {
      this.videoLoop.reset(); this.video.removeAttribute('src'); this.video.load(); this.image.removeAttribute('src');
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = asset ? URL.createObjectURL(asset.blob) : null;
      this.image.hidden = !asset || type !== 'image'; this.video.hidden = !asset || type !== 'video';
      if (asset) (type === 'image' ? this.image : this.video).src = this.url;
      this.displayedAsset = asset;
    }
    this.playVideo();
  }
  async chooseFile() {
    const file = this.file.files[0]; this.file.value = ''; if (!file) return;
    const type = this.settings.type;
    if (!['image', 'video'].includes(type) || !file.type.startsWith(type + '/')) { this.notify('请选择对应类型的图片或视频文件'); return; }
    this.revision++; this.asset = { type, name: file.name, blob: file }; this.render();
    try { await mediaStore('put', this.asset); }
    catch { this.notify('背景已应用，但本机保存失败，刷新后可能需要重新选择文件'); }
  }
}
