export const DEFAULT_LYRIC_LEAD_MS = 200;
export function normalizeLyricLead(value) {
  return Number.isFinite(value) ? Math.max(-1000, Math.min(1000, Math.round(value))) : DEFAULT_LYRIC_LEAD_MS;
}
export function visualLyricTime(positionMs, lyricOffsetMs, leadMs = DEFAULT_LYRIC_LEAD_MS) {
  return positionMs - lyricOffsetMs + normalizeLyricLead(leadMs);
}
