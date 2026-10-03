/** Small, dependency-free formatting for explanation text. */

export function ms(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(2)}s`;
  if (Math.abs(value) >= 100) return `${Math.round(value)}ms`;
  if (Math.abs(value) >= 10) return `${value.toFixed(1)}ms`;
  return `${value.toFixed(2)}ms`;
}

export function at(time: number): string {
  return `t=${ms(time)}`;
}

export function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(ratio < 0.1 ? 1 : 0)}%`;
}

export function humanize(type: string): string {
  const words = type.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** "a, b and c" */
export function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
