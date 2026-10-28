import { buildMv, groupAt, wordProgress, mvTransition, wordTilt } from '../shared/mv.js';
import { MvBackground } from './mv-background.js';
import { MvTypography, wordFontSize } from './mv-typography.js';

const fonts = [
  { id: 'sans', label: '黑体', family: '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif' },
  { id: 'yahei', label: '微软雅黑', family: '"Microsoft YaHei", "Microsoft YaHei UI", "PingFang SC", sans-serif' },
  { id: 'serif', label: '宋体', family: 'SimSun, "Songti SC", "Noto Serif SC", serif' },
  { id: 'kai', label: '楷体', family: 'KaiTi, STKaiti, "Kaiti SC", serif' },
  { id: 'fangsong', label: '仿宋', family: 'FangSong, STFangsong, "Songti SC", serif' },
  { id: 'system', label: '系统默认', family: 'system-ui, sans-serif' },
];

let tokenizer;
function getTokenizer() {
  if (!tokenizer) tokenizer = import('/vendor/jieba/jieba_rs_wasm.js').then(async module => { await module.default(); return module.cut; }).catch(error => { tokenizer = null; throw error; });
  return tokenizer;
}
export class LyricMv {
  constructor(element, notify) {
    this.element = element; this.stage = element.querySelector('.mv-stage'); this.notify = notify;
    this.background = new MvBackground(element, notify);
    this.groups = []; this.index = -1; this.key = ''; this.generation = 0; this.visible = false;
    this.layerKey = ''; this.layers = [];
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    this.title = element.querySelector('.mv-song'); this.status = element.querySelector('.mv-status');
    this.fontSelect = element.querySelector('#mv-font');
    this.fontSelect.replaceChildren(...fonts.map(font => {
      const option = document.createElement('option'); option.value = font.id; option.textContent = font.label; return option;
    }));
    let savedFont;
    try { savedFont = localStorage.getItem('sync-room:mv-font'); } catch {}
    this.setFont(savedFont);
    this.fontSelect.onchange = () => this.setFont(this.fontSelect.value);
    this.typography = new MvTypography(element, options => this.refreshTypography(options));
    element.addEventListener('mv-settings-open', event => {
      if (event.target !== this.typography.panel) this.typography.showPanel(false);
      if (event.target !== this.background.panel) this.background.showPanel(false);
    });
    new ResizeObserver(() => { this.fit(); if (this.lastFrame) this.update(...this.lastFrame); }).observe(this.stage);
  }
  refreshTypography({ layout = true } = {}) {
    if (!this.typography) return;
    if (layout) {
      for (const span of this.stage.querySelectorAll('.mv-word')) span.style.fontSize = `${wordFontSize(Number(span.dataset.weight), this.typography.settings)}px`;
      this.fit();
    }
    if (this.lastFrame) this.update(...this.lastFrame);
  }
  setFont(id) {
    const font = fonts.find(font => font.id === id) || fonts[0];
    this.fontSelect.value = font.id;
    this.stage.style.fontFamily = font.family;
    try { localStorage.setItem('sync-room:mv-font', font.id); } catch {}
    this.fit();
    if (this.lastFrame) this.update(...this.lastFrame);
  }
  async setLyrics(lines, durationMs) {
    const key = JSON.stringify([lines, durationMs]); if (this.key === key) return;
    this.key = key; const generation = ++this.generation; this.index = -1; this.groups = [];
    this.layerKey = ''; this.layers = [];
    this.stage.replaceChildren(); this.status.textContent = lines.some(line => line.text.trim()) ? '正在用 jieba 编排歌词…' : '上传 LRC 歌词，开始制作歌词 MV';
    if (!lines.some(line => line.text.trim())) return;
    try {
      const cut = await getTokenizer();
      if (generation !== this.generation) return;
      this.groups = buildMv(lines, cut, durationMs);
      this.status.textContent = '跟随房间时间轴';
    } catch {
      if (generation !== this.generation) return;
      this.key = ''; this.status.textContent = '分词加载失败，请重新打开 MV 重试'; this.notify('jieba 加载失败，请检查连接后重新打开 MV');
    }
  }
  update(timeMs, status, name) {
    this.lastFrame = [timeMs, status, name];
    if (!this.visible) return;
    this.title.textContent = name;
    const index = groupAt(this.groups, timeMs);
    if (index < 0) return;
    const layers = mvTransition(this.groups, timeMs, this.reducedMotion.matches);
    const layerKey = layers.map(layer => `${layer.role}:${layer.index}`).join(',');
    if (layerKey !== this.layerKey) {
      this.index = index; this.layerKey = layerKey; this.stage.replaceChildren();
      this.layers = layers.map(layer => {
        const group = document.createElement('div'); group.className = `mv-group mv-${layer.role}`;
        if (layer.role === 'preview') group.setAttribute('aria-label', '后两行歌词预览');
        const main = document.createElement('div'); main.className = 'mv-main';
        this.groups[layer.index].rows.forEach(row => main.append(this.createLine(row)));
        group.append(main);
        this.stage.append(group); return { group, main };
      });
      this.fit();
    }
    const current = layers.find(layer => layer.role === 'current');
    const mainHeight = this.layers[layers.indexOf(current)].main.offsetHeight;
    const outgoingIndex = layers.findIndex(layer => layer.role === 'outgoing');
    const previousHeight = outgoingIndex < 0 ? mainHeight : this.layers[outgoingIndex].main.offsetHeight;
    const gap = Math.max(18, Math.min(32, this.stage.clientHeight * 0.045));
    const incomingY = ((previousHeight + mainHeight * 0.48) / 2 + gap) * (1 - current.ease);
    layers.forEach((layer, layerIndex) => {
      const { group, main } = this.layers[layerIndex];
      const height = main.offsetHeight;
      const right = this.stage.clientWidth * 0.16;
      let x = 0, y = 0;
      if (layer.role === 'preview') { x = right; y = incomingY + (mainHeight * current.scale + height * 0.48) / 2 + gap; }
      if (layer.role === 'current' && layer.ease < 1) {
        x = right * (1 - layer.ease); y = incomingY;
      }
      if (layer.role === 'outgoing') { x = -right * layer.ease; y = -((mainHeight + height * 0.48) / 2 + gap) * layer.ease; }
      group.style.opacity = layer.opacity;
      group.style.transform = `translate(-50%, -50%) translate(${x + this.typography.settings.offsetX}px, ${y + this.typography.settings.offsetY}px) scale(${layer.scale})`;
      group.setAttribute('aria-hidden', String(layer.role === 'outgoing'));
      this.groups[layer.index].rows.forEach((row, rowIndex) => {
        const line = main.children[rowIndex];
        line.classList.toggle('mv-current', layer.role === 'current' && timeMs >= row.timeMs && timeMs < row.endMs);
        line.classList.toggle('mv-complete', timeMs >= row.endMs);
        [...line.firstElementChild.children].forEach((span, index) => {
          const progress = wordProgress(row, row.words[index], timeMs);
          span.style.opacity = layer.role === 'current' ? String(1 - layer.ease * (1 - progress) * 0.35) : '1';
          span.style.translate = `0 ${layer.role === 'current' ? layer.ease * (1 - progress) * 0.1 : 0}em`;
        });
      });
    });
    this.status.textContent = `${status === 'PLAYING' ? '正在播放' : status === 'ENDED' ? '播放结束' : '等待 / 已暂停'} · ${index + 1} / ${this.groups.length} 组`;
  }
  createLine(row) {
    const line = document.createElement('div'); line.className = 'mv-line'; line.setAttribute('aria-label', row.text);
    const words = document.createElement('div'); words.className = 'mv-words';
    row.words.forEach((word, index) => {
      const span = document.createElement('span'); span.className = 'mv-word'; span.textContent = word.text; span.dataset.weight = word.size; span.style.fontSize = `${wordFontSize(word.size, this.typography.settings)}px`; span.style.rotate = `${wordTilt(word.text, index, row.timeMs)}deg`; words.append(span);
    });
    line.append(words); return line;
  }
  fit() {
    if (!this.visible) return;
    this.stage.style.setProperty('--mv-gap-limit', `${this.stage.clientHeight * 0.08}px`);
    for (const line of this.stage.querySelectorAll('.mv-line')) {
      const words = line.firstElementChild; words.style.transform = ''; line.style.height = '';
      const available = line.clientWidth - 32;
      const scale = Math.min(1, available / Math.max(1, words.offsetWidth), this.stage.clientHeight * 0.18 / Math.max(1, words.offsetHeight));
      words.style.transform = `scale(${Math.max(0.01, scale)})`;
      line.style.height = `${words.offsetHeight * Math.max(0.01, scale)}px`;
    }
  }
}
