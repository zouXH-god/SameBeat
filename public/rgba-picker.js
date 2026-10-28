const bound = (value, min, max) => Math.max(min, Math.min(max, value));
export function parseRgba(value) {
  if (typeof value !== 'string' || value.length > 128) return null;
  const hex = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.exec(value.trim());
  if (hex) {
    let digits = hex[1];
    if (digits.length < 5) digits = [...digits].map(char => char + char).join('');
    return { r: parseInt(digits.slice(0, 2), 16), g: parseInt(digits.slice(2, 4), 16), b: parseInt(digits.slice(4, 6), 16), a: digits.length === 8 ? parseInt(digits.slice(6), 16) / 255 : 1 };
  }
  const match = /^(rgba?)\(([^)]+)\)$/i.exec(value.trim());
  if (!match) return null;
  const parts = match[2].split(',').map(part => part.trim());
  if (parts.length !== (match[1].toLowerCase() === 'rgba' ? 4 : 3)) return null;
  if (parts.some(part => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(part))) return null;
  const numbers = parts.map((part, i) => part.endsWith('%') ? Number(part.slice(0, -1)) / 100 * (i === 3 ? 1 : 255) : Number(part));
  if (!numbers.every(Number.isFinite)) return null;
  return { r: Math.round(bound(numbers[0], 0, 255)), g: Math.round(bound(numbers[1], 0, 255)), b: Math.round(bound(numbers[2], 0, 255)), a: bound(numbers[3] ?? 1, 0, 1) };
}
export const formatRgba = ({ r, g, b, a }) => `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;
export function normalizeRgba(value, fallback = 'rgba(0, 0, 0, 1)') {
  return formatRgba(parseRgba(value) || parseRgba(fallback) || { r: 0, g: 0, b: 0, a: 1 });
}
export function legacyRgba(value, fallback, alpha) {
  const color = parseRgba(value) || parseRgba(fallback);
  if (Number.isFinite(alpha)) color.a = bound(alpha, 0, 1);
  return formatRgba(color);
}

export class RgbaPicker {
  constructor(root, value, onChange) {
    this.root = root; this.onChange = onChange; root.classList.add('mv-rgba');
    const label = root.dataset.rgbaLabel;
    const heading = document.createElement('span'); heading.className = 'mv-rgba-label'; heading.textContent = label;
    const row = document.createElement('div'); row.className = 'mv-rgba-row';
    this.button = document.createElement('button'); this.button.type = 'button'; this.button.className = 'mv-rgba-swatch';
    this.button.setAttribute('aria-label', `${label}调色板`); this.button.setAttribute('aria-expanded', 'false');
    this.sample = document.createElement('span'); this.button.append(this.sample);
    this.text = document.createElement('input'); this.text.type = 'text'; this.text.spellcheck = false; this.text.setAttribute('aria-label', `${label} RGBA`);
    row.append(this.button, this.text);
    this.editor = document.createElement('div'); this.editor.className = 'mv-rgba-editor'; this.editor.hidden = true;
    const rgbLabel = document.createElement('label'); rgbLabel.textContent = '系统色盘';
    this.rgb = document.createElement('input'); this.rgb.type = 'color'; this.rgb.setAttribute('aria-label', `${label} RGB`); rgbLabel.append(this.rgb); this.editor.append(rgbLabel);
    this.channels = {};
    for (const channel of ['a']) {
      const line = document.createElement('div'); line.className = 'mv-rgba-channel';
      const title = document.createElement('span'); title.textContent = '透明度'; line.append(title);
      const inputs = ['range', 'number'].map(type => {
        const input = document.createElement('input'); input.type = type; input.min = '0'; input.max = channel === 'a' ? '1' : '255'; input.step = channel === 'a' ? '0.01' : '1';
        input.setAttribute('aria-label', `${label} 透明度${type === 'number' ? ' 数值' : ''}`);
        input.oninput = () => {
          if (input.value === '') return;
          const next = { ...this.value, [channel]: channel === 'a' ? bound(Number(input.value), 0, 1) : Math.round(bound(Number(input.value), 0, 255)) };
          this.commit(next);
        };
        input.onchange = () => this.set(formatRgba(this.value), true); input.onblur = input.onchange; line.append(input); return input;
      });
      this.channels[channel] = inputs; this.editor.append(line);
    }
    const hint = document.createElement('p'); hint.textContent = '透明度：0 完全透明，1 完全不透明'; this.editor.append(hint);
    root.replaceChildren(heading, row, this.editor);
    this.button.onclick = () => { this.editor.hidden = !this.editor.hidden; this.button.setAttribute('aria-expanded', String(!this.editor.hidden)); };
    this.rgb.oninput = () => this.commit({ ...parseRgba(this.rgb.value), a: this.value.a });
    this.text.oninput = () => {
      const parsed = parseRgba(this.text.value); this.text.setAttribute('aria-invalid', String(!parsed));
      if (parsed) this.commit(parsed);
    };
    this.text.onchange = () => this.set(formatRgba(this.value), true);
    this.text.onblur = this.text.onchange;
    root.onkeydown = event => {
      if (event.key === 'Escape' && !this.editor.hidden) { event.preventDefault(); event.stopPropagation(); this.editor.hidden = true; this.button.setAttribute('aria-expanded', 'false'); this.button.focus(); }
    };
    this.set(value);
  }
  commit(value) { this.set(formatRgba(value)); this.onChange(formatRgba(this.value)); }
  set(value, force = false) {
    this.value = parseRgba(normalizeRgba(value));
    const css = formatRgba(this.value); this.sample.style.backgroundColor = css;
    if (force || document.activeElement !== this.text) { this.text.value = css; this.text.setAttribute('aria-invalid', 'false'); }
    this.rgb.value = '#' + ['r', 'g', 'b'].map(channel => this.value[channel].toString(16).padStart(2, '0')).join('');
    for (const [channel, inputs] of Object.entries(this.channels)) for (const input of inputs) {
      if (force || document.activeElement !== input || input.type === 'range') input.value = this.value[channel];
    }
  }
}
