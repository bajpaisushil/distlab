'use client';

import { useCallback, useRef, useState } from 'react';
import { useLab } from '@/lib/store';
import type { MarkerKind } from '@/lib/engine/protocol';
import { formatClock, formatCount } from '@/lib/format';

const MARKER_TONE: Record<MarkerKind, string> = {
  fault: 'status-warning',
  failure: 'status-critical',
  recovery: 'status-good',
  leader: 'status-neutral',
  violation: 'status-critical',
  circuit: 'status-serious',
  partition: 'status-critical',
};

/**
 * The replay scrubber, in virtual time. The track shows how far the run has
 * been computed; anything already computed can be revisited exactly, because
 * the engine is deterministic. Markers flag faults, failures and recoveries.
 */
export function Timeline() {
  const frame = useLab((s) => s.frame);
  const seekTime = useLab((s) => s.seekTime);
  const select = useLab((s) => s.select);
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const duration = frame?.durationMs ?? 1;
  const now = frame?.now ?? 0;
  const known = frame?.reachableTime ?? now;

  const timeAt = useCallback(
    (clientX: number) => {
      const rect = ref.current?.getBoundingClientRect();
      if (!rect) return 0;
      return Math.max(0, Math.min(duration, ((clientX - rect.left) / rect.width) * duration));
    },
    [duration],
  );

  const pct = (t: number) => `${Math.max(0, Math.min(100, (t / duration) * 100))}%`;

  return (
    <div className="timeline">
      <span className="mono num muted" style={{ whiteSpace: 'nowrap' }} title="Events processed / computed so far">
        #{formatCount(frame?.position ?? 0)}
        <span className="hide-narrow"> / {formatCount(frame?.reachable ?? 0)}</span>
      </span>
      <div
        ref={ref}
        className="scrubber"
        role="slider"
        aria-label="Replay position"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={now}
        aria-valuetext={formatClock(now)}
        tabIndex={0}
        data-testid="scrubber"
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          setDragging(true);
          seekTime(timeAt(e.clientX));
        }}
        onPointerMove={(e) => {
          setHover(timeAt(e.clientX));
          if (dragging) seekTime(timeAt(e.clientX));
        }}
        onPointerUp={() => setDragging(false)}
        onPointerLeave={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') seekTime(Math.min(duration, now + duration / 100));
          if (e.key === 'ArrowLeft') seekTime(Math.max(0, now - duration / 100));
        }}
      >
        <div className="scrubber-track" />
        <div className="scrubber-known" style={{ width: pct(known) }} />
        <div className="scrubber-fill" style={{ width: pct(now) }} />
        {frame?.markers.map((m) => (
          <span
            key={m.eventId}
            className={`marker ${MARKER_TONE[m.kind]}`}
            style={{ left: pct(m.at) }}
            title={`${formatClock(m.at)} — ${m.label}`}
            onPointerDown={(e) => {
              e.stopPropagation();
              select({ kind: 'event', id: m.eventId });
              seekTime(m.at);
            }}
          />
        ))}
        <div className="scrubber-head" style={{ left: pct(now) }} />
        {hover !== null ? (
          <div className="tooltip" style={{ left: `calc(${pct(hover)} - 40px)`, top: -30, minWidth: 0 }}>
            <span className="mono num">{formatClock(hover)}</span>
          </div>
        ) : null}
      </div>
      <span className="mono num" style={{ whiteSpace: 'nowrap' }}>
        {formatClock(now)}
      </span>
    </div>
  );
}
