export function normalizeMix(value) {
  return Object.fromEntries(['instrumental', 'vocal'].map(type => [type,
    Number.isFinite(value?.[type]) ? Math.max(0, Math.min(1, value[type])) : 1,
  ]));
}
export function validMix(value) {
  return ['instrumental', 'vocal'].every(type => Number.isFinite(value?.[type]) && value[type] >= 0 && value[type] <= 1);
}
