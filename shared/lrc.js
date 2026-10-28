export function parseLrc(text) {
  const offset = Number(text.match(/\[offset:([+-]?\d+)\]/i)?.[1] || 0);
  const lines = [];
  for (const line of text.split(/\r?\n/)) {
    // Consecutive timestamps before the text repeat a whole line. Timestamps
    // interleaved with text instead mark individual words, not duplicate lines.
    const prefix = line.match(/^\s*((?:\[\d+:\d{2}(?:[.:]\d{1,3})?\]\s*)+)/)?.[1];
    if (!prefix) continue;
    const stamps = [...prefix.matchAll(/\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const content = line.replace(/\[[^\]]*\]/g, '').replace(/<\d+:\d+(?:\.\d+)?>/g, '').trim();
    // Some word-timed files end a physical line with an explicit final timestamp.
    // Retain this boundary so the MV can advance after singing ends, before an instrumental gap.
    const ending = line.match(/[\[<](\d+):(\d{2})(?:[.:](\d{1,3}))?[\]>]\s*$/);
    const timedBody = line.slice(line.indexOf(prefix) + prefix.length);
    const hasInlineTiming = /[\[<]\d+:\d{2}(?:[.:]\d{1,3})?[\]>]/.test(timedBody);
    const endingMs = ending && Number(ending[2]) < 60 && hasInlineTiming && content
      ? Number(ending[1]) * 60000 + Number(ending[2]) * 1000 + Number((ending[3] || '').padEnd(3, '0')) : null;
    for (const stamp of stamps) {
      if (Number(stamp[2]) >= 60) continue;
      const startMs = Number(stamp[1]) * 60000 + Number(stamp[2]) * 1000 + Number((stamp[3] || '').padEnd(3, '0'));
      const firstMs = Number(stamps[0][1]) * 60000 + Number(stamps[0][2]) * 1000 + Number((stamps[0][3] || '').padEnd(3, '0'));
      const entry = { timeMs: Math.max(0, startMs + offset), text: content };
      if (endingMs !== null && endingMs > firstMs) entry.endMs = Math.max(entry.timeMs, endingMs + (startMs - firstMs) + offset);
      lines.push(entry);
    }
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs);
}
