import { normalizeMix } from '../shared/mix.js';
export { normalizeMix };
const key = 'sync-room:local-mix';
export function loadMix(storage) {
  try { return normalizeMix(JSON.parse(storage.getItem(key))); } catch { return normalizeMix(null); }
}
export function saveMix(storage, mix) {
  try { storage.setItem(key, JSON.stringify(normalizeMix(mix))); } catch { /* Playback remains available when browser storage is blocked. */ }
}
