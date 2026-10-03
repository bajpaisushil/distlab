/** Display formatting. Pure, locale-stable, and never rounds a value into a different meaning. */

export function formatMs(ms: number | undefined, digits?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  // Configured values are usually whole milliseconds: "2ms", not "2.00ms".
  if (digits === undefined && Number.isInteger(ms) && Math.abs(ms) < 1000) return `${ms}ms`;
  const abs = Math.abs(ms);
  if (abs >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (abs >= 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (abs >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (abs >= 100) return `${ms.toFixed(digits ?? 0)}ms`;
  if (abs >= 10) return `${ms.toFixed(digits ?? 1)}ms`;
  return `${ms.toFixed(digits ?? 2)}ms`;
}

/** Virtual clock reading, e.g. `00:05.250`. */
export function formatClock(ms: number): string {
  const total = Math.max(0, ms);
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = Math.floor(total % 1000);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

export function formatPercent(ratio: number | undefined, digits = 1): string {
  if (ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function formatCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e4) return `${(value / 1e3).toFixed(1)}K`;
  return Math.round(value).toLocaleString('en-US');
}

export function formatRate(perSecond: number | undefined): string {
  if (perSecond === undefined || !Number.isFinite(perSecond)) return '—';
  if (perSecond >= 100) return `${Math.round(perSecond).toLocaleString('en-US')}/s`;
  return `${perSecond.toFixed(1)}/s`;
}

export function formatSpeed(speed: number): string {
  return speed >= 1 ? `${speed}×` : `${speed}×`;
}

/** Event type names read better as words: REQUEST_FAILED -> Request failed. */
export function humanize(type: string): string {
  const words = type.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
