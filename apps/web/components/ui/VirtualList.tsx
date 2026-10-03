'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Renders only the rows in view. Fixed row height keeps it simple and fast
 * enough for event streams in the hundreds of thousands.
 */
export function VirtualList<T>({
  items,
  total,
  rowHeight = 24,
  render,
  onRange,
  follow,
  header,
}: {
  /** Rows available, starting at `items.offset`. */
  items: { offset: number; rows: readonly T[] };
  total: number;
  rowHeight?: number;
  render(row: T, index: number): React.ReactNode;
  /** Called with the visible index range so the caller can fetch it. */
  onRange?(start: number, end: number): void;
  /** Keep the newest row in view while the user hasn't scrolled away. */
  follow?: boolean;
  header?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(300);
  const atBottom = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (el && follow && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [total, follow]);

  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 10);
  const end = Math.min(total, Math.ceil((scrollTop + height) / rowHeight) + 10);

  useEffect(() => {
    onRange?.(start, end);
  }, [start, end, onRange]);

  const visible: React.ReactNode[] = [];
  for (let i = start; i < end; i++) {
    const row = items.rows[i - items.offset];
    visible.push(
      <div key={i} style={{ position: 'absolute', top: i * rowHeight, left: 0, right: 0, height: rowHeight }}>
        {row !== undefined ? render(row, i) : <div className="muted" style={{ padding: '4px 10px' }}>…</div>}
      </div>,
    );
  }

  return (
    <div style={{ display: 'grid', gridTemplateRows: header ? 'auto minmax(0,1fr)' : 'minmax(0,1fr)', height: '100%', minHeight: 0 }}>
      {header}
      <div
        ref={ref}
        style={{ overflowY: 'auto', position: 'relative', minHeight: 0 }}
        onScroll={(e) => {
          const el = e.currentTarget;
          setScrollTop(el.scrollTop);
          atBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - rowHeight * 1.5;
        }}
      >
        <div style={{ height: total * rowHeight, position: 'relative' }}>{visible}</div>
      </div>
    </div>
  );
}
