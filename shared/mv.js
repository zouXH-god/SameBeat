const clamp = value => Math.max(0, Math.min(1, value));
export function wordSize(word, index) {
  const weights = [0.86, 1.2, 0.98, 1.38, 1.08];
  return weights[index % weights.length] * (word.trim().length === 1 ? 0.88 : 1);
}
export function wordTilt(word, index, timeMs = 0) {
  let hash = Math.round(timeMs) + index * 17;
  for (const character of word) hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  return ((hash % 61) - 30) / 10;
}
export function buildMv(lines, cut, durationMs) {
  const sorted = [...lines].sort((a, b) => a.timeMs - b.timeMs);
  const rows = sorted.filter(line => line.text.trim()).map(line => {
    const next = sorted.find(candidate => candidate.timeMs > line.timeMs);
    const fallbackEnd = durationMs > line.timeMs ? durationMs : line.timeMs + 5000;
    const endMs = Math.max(line.timeMs + 1, Math.min(line.endMs ?? next?.timeMs ?? fallbackEnd, next?.timeMs ?? Infinity));
    const words = cut(line.text, true);
    // Keep all text, including punctuation and spaces, even if the tokenizer behaves unexpectedly.
    const tokens = words.join('') === line.text ? words : [line.text];
    const length = Math.max(1, tokens.reduce((sum, word) => sum + word.length, 0));
    let offset = 0;
    return { ...line, endMs, words: tokens.map((word, index) => {
      const start = offset / length; offset += word.length;
      return { text: word, size: wordSize(word, index), start, end: offset / length };
    }) };
  });
  const groups = [];
  for (let i = 0; i < rows.length; i += 2) {
    const previous = rows[i - 1];
    groups.push({ at: previous ? Math.min(previous.endMs, rows[i].timeMs) : rows[i].timeMs, rows: rows.slice(i, i + 2) });
  }
  return groups;
}
export function groupAt(groups, timeMs) {
  if (!groups.length) return -1;
  let index = 0;
  while (index + 1 < groups.length && groups[index + 1].at <= timeMs) index++;
  return index;
}
export function wordProgress(row, word, timeMs) {
  const progress = clamp((timeMs - row.timeMs) / (row.endMs - row.timeMs));
  return clamp((progress - word.start) / Math.max(0.001, word.end - word.start));
}

export function mvTransition(groups, timeMs, reducedMotion = false) {
  const index = groupAt(groups, timeMs);
  if (index < 0) return [];
  // Preview and main use the same typesetting, so the preview can grow into place.
  const nextAt = groups[index + 1]?.at ?? Infinity;
  const duration = Math.min(600, nextAt - groups[index].at);
  const progress = index === 0 || reducedMotion || duration <= 0 ? 1 : clamp((timeMs - groups[index].at) / duration);
  const ease = 1 - (1 - progress) ** 3;
  const layers = [];
  if (index > 0 && progress < 1) layers.push({ index: index - 1, role: 'outgoing', opacity: 1 - ease, scale: 1 - 0.52 * ease, ease });
  layers.push({ index, role: 'current', opacity: 0.32 + 0.68 * ease, scale: 0.48 + 0.52 * ease, ease });
  if (groups[index + 1]) layers.push({ index: index + 1, role: 'preview', opacity: 0.32 * clamp((ease - 0.6) / 0.4), scale: 0.48, ease });
  return layers;
}
