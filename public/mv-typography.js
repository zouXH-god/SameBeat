import { RgbaPicker, normalizeRgba, legacyRgba, parseRgba, formatRgba } from './rgba-picker.js';
const key = 'sync-room:mv-typography';
export const typographyDefaults = Object.freeze({
  minSize: 28, maxSize: 72, lineGap: 32, offsetX: 0, offsetY: 0, color: 'rgba(255, 255, 255, 1)',
  shadowEnabled: true, shadowColor: 'rgba(0, 0, 0, 0.6)', shadowBlur: 14, shadowX: 0, shadowY: 2,
  strokeEnabled: false, strokeColor: 'rgba(0, 0, 0, 1)', strokeWidth: 1,
});
const limits = { minSize: [8, 200], maxSize: [8, 200], lineGap: [0, 120], offsetX: [-4000, 4000], offsetY: [-4000, 4000], shadowBlur: [0, 60], shadowX: [-40, 40], shadowY: [-40, 40], strokeWidth: [0, 6] };
export function normalizeTypography(value) {
  const settings = { ...typographyDefaults };
  for (const [name, fallback] of Object.entries(settings)) {
    const candidate = value?.[name];
    if (limits[name]) settings[name] = Number.isFinite(candidate) ? Math.max(limits[name][0], Math.min(limits[name][1], candidate)) : fallback;
    else if (typeof fallback === 'boolean') settings[name] = typeof candidate === 'boolean' ? candidate : fallback;
    else settings[name] = normalizeRgba(candidate, fallback);
  }
  if (settings.minSize > settings.maxSize) [settings.minSize, settings.maxSize] = [settings.maxSize, settings.minSize];
  // Migrate old separate opacity fields into the colors' alpha channels.
  settings.color = legacyRgba(value?.color, typographyDefaults.color, value?.opacity);
  settings.shadowColor = legacyRgba(value?.shadowColor, typographyDefaults.shadowColor, value?.shadowOpacity);
  if (Number.isFinite(value?.opacity)) {
    for (const name of ['shadowColor', 'strokeColor']) {
      const color = parseRgba(settings[name]); color.a *= Math.max(0, Math.min(1, value.opacity)); settings[name] = formatRgba(color);
    }
  }
  return settings;
}
export function wordFontSize(weight, settings) {
  const factor = Math.max(0, Math.min(1, (weight - 0.7568) / (1.38 - 0.7568)));
  return settings.minSize + (settings.maxSize - settings.minSize) * factor;
}
export class MvTypography {
  constructor(element, refresh) {
    this.stage = element.querySelector('.mv-stage'); this.refresh = refresh;
    this.panel = element.querySelector('#mv-typography-settings'); this.toggle = element.querySelector('#mv-typography-toggle');
    this.controls = [...this.panel.querySelectorAll('[data-typography]')];
    let saved;
    try { saved = JSON.parse(localStorage.getItem(key)); } catch {}
    this.settings = normalizeTypography(saved);
    this.colors = [...this.panel.querySelectorAll('[data-rgba-setting]')].map(root => ({
      name: root.dataset.rgbaSetting,
      picker: new RgbaPicker(root, this.settings[root.dataset.rgbaSetting], color => {
        this.settings[root.dataset.rgbaSetting] = color; this.save(); this.apply();
      }),
    }));
    this.toggle.onclick = () => this.showPanel(this.panel.hidden);
    element.querySelector('#mv-typography-done').onclick = () => { this.showPanel(false); this.toggle.focus(); };
    this.panel.onkeydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.showPanel(false); this.toggle.focus(); }
    };
    for (const control of this.controls) control.oninput = () => {
      const name = control.dataset.typography;
      if (control.type === 'number' && control.value === '') return;
      const value = control.type === 'checkbox' ? control.checked : limits[name] ? Number(control.value) : control.value;
      const next = { ...this.settings, [name]: value };
      if (name === 'minSize') next.maxSize = Math.max(value, next.maxSize);
      if (name === 'maxSize') next.minSize = Math.min(value, next.minSize);
      this.settings = normalizeTypography(next); this.save(); this.apply();
    };
    for (const control of this.controls) { control.onchange = () => this.apply(true); control.onblur = control.onchange; }
    element.querySelector('#mv-offset-reset').onclick = () => { this.settings.offsetX = 0; this.settings.offsetY = 0; this.save(); this.apply(true); };
    element.querySelector('#mv-typography-reset').onclick = () => { this.settings = { ...typographyDefaults }; this.save(); this.apply(); };
    this.apply();
  }
  showPanel(show) {
    if (show) this.panel.dispatchEvent(new CustomEvent('mv-settings-open', { bubbles: true }));
    this.panel.hidden = !show; this.toggle.setAttribute('aria-expanded', String(show));
    if (show) this.controls[0].focus();
  }
  save() {
    try { localStorage.setItem(key, JSON.stringify(this.settings)); } catch {}
  }
  apply(commit = false) {
    const s = this.settings;
    for (const control of this.controls) {
      const value = s[control.dataset.typography];
      if (control.type === 'checkbox') control.checked = value;
      else if (commit || control.type !== 'number' || document.activeElement !== control) control.value = value;
    }
    for (const { name, picker } of this.colors) picker.set(s[name]);
    const shadow = s.shadowEnabled ? `${s.shadowX}px ${s.shadowY}px ${s.shadowBlur}px ${s.shadowColor}` : 'none';
    for (const [name, value] of Object.entries({
      '--mv-font-max': `${s.maxSize}px`, '--mv-line-gap': `${s.lineGap}px`, '--mv-text-color': s.color,
      '--mv-text-shadow': shadow,
      '--mv-stroke-width': `${s.strokeEnabled ? s.strokeWidth : 0}px`, '--mv-stroke-color': s.strokeColor,
    })) this.stage.style.setProperty(name, value);
    const geometry = JSON.stringify([s.minSize, s.maxSize, s.lineGap]);
    const layout = geometry !== this.geometry; this.geometry = geometry;
    this.refresh({ layout });
  }
}
