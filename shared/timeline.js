export function activeTimeline(playback, now) {
  return playback.pending && now >= playback.pending.at ? playback.pending.next : playback;
}

export function positionAt(playback, now, duration = Infinity) {
  const current = activeTimeline(playback, now);
  const position = current.status === 'PLAYING'
    ? current.positionMs + Math.max(0, now - current.startServerTime)
    : current.positionMs;
  return Math.max(0, Math.min(duration, position));
}

export function schedule(playback, action, now, duration, positionMs) {
  const at = now + 700;
  const current = activeTimeline(playback, now);
  const position = action === 'STOP' ? 0 : action === 'SEEK'
    ? Math.max(0, Math.min(duration, positionMs)) : positionAt(playback, at, duration);
  const status = action === 'PLAY' || (action === 'SEEK' && current.status === 'PLAYING')
    ? 'PLAYING' : action === 'STOP' ? 'STOPPED' : 'PAUSED';
  return { ...current, pending: { at, next: {
    status, positionMs: action === 'PLAY' && position >= duration ? 0 : position,
    startServerTime: at,
  } } };
}
