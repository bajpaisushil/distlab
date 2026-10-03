'use client';

import { useMemo, useState } from 'react';
import { formatClock } from '@/lib/format';
import { niceMax, niceTicks, useWidth } from './use-size';

export interface Series {
  readonly id: string;
  readonly label: string;
  /** A CSS colour, normally a palette variable such as var(--series-1). */
  readonly color: string;
  readonly points: readonly { readonly t: number; readonly value: number }[];
  /** Draw as a step function — for values that change at instants (depth, leader, lag). */
  readonly step?: boolean;
}

export interface ChartMarker {
  readonly t: number;
  readonly label: string;
  readonly color: string;
}

interface Props {
  readonly title: string;
  readonly subtitle?: string;
  readonly series: readonly Series[];
  readonly format: (value: number) => string;
  readonly xMax: number;
  readonly now?: number;
  readonly height?: number;
  readonly markers?: readonly ChartMarker[];
  readonly area?: boolean;
  readonly yMax?: number;
  readonly empty?: string;
}

const PAD = { top: 8, right: 12, bottom: 20, left: 44 };

/**
 * Line chart over virtual time. One y-axis, always: series of different units
 * get separate charts. Hovering anywhere snaps a crosshair to the nearest
 * instant and lists every series' value there, so nobody has to aim at a 2px line.
 */
export function TimeSeriesChart({
  title,
  subtitle,
  series,
  format,
  xMax,
  now,
  height = 150,
  markers = [],
  area = false,
  yMax: fixedYMax,
  empty = 'No data yet — press play.',
}: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hoverX, setHoverX] = useState<number | null>(null);

  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const hasData = series.some((s) => s.points.length > 0);

  const yMax = useMemo(() => {
    if (fixedYMax !== undefined) return fixedYMax;
    let max = 0;
    for (const s of series) for (const p of s.points) if (p.value > max) max = p.value;
    return niceMax(max);
  }, [series, fixedYMax]);

  const x = (t: number) => PAD.left + (Math.min(t, xMax) / Math.max(1, xMax)) * plotW;
  const y = (v: number) => PAD.top + plotH - (Math.min(v, yMax) / yMax) * plotH;

  const paths = useMemo(
    () =>
      series.map((s) => {
        if (s.points.length === 0) return { id: s.id, line: '', fill: '' };
        let d = '';
        s.points.forEach((p, i) => {
          if (i === 0) d += `M${x(p.t)},${y(p.value)}`;
          else if (s.step) d += `H${x(p.t)}V${y(p.value)}`;
          else d += `L${x(p.t)},${y(p.value)}`;
        });
        const last = s.points[s.points.length - 1]!;
        if (s.step && now !== undefined && now > last.t) d += `H${x(now)}`;
        const endX = s.step && now !== undefined ? x(Math.max(now, last.t)) : x(last.t);
        const fill = `${d}L${endX},${PAD.top + plotH}L${x(s.points[0]!.t)},${PAD.top + plotH}Z`;
        return { id: s.id, line: d, fill };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, plotW, plotH, yMax, xMax, now],
  );

  const xTicks = niceTicks(0, xMax, Math.max(2, Math.floor(plotW / 90)));
  const yTicks = niceTicks(0, yMax, 3);

  const hoverT = hoverX === null ? null : Math.max(0, Math.min(xMax, ((hoverX - PAD.left) / plotW) * xMax));
  const readout =
    hoverT === null
      ? []
      : series.map((s) => ({ series: s, value: valueAt(s, hoverT) })).filter((r) => r.value !== undefined);

  return (
    <div className="chart-card">
      <div className="row" style={{ alignItems: 'baseline' }}>
        <div style={{ minWidth: 0 }}>
          <h4 className="chart-title">{title}</h4>
          {subtitle ? <p className="chart-subtitle">{subtitle}</p> : null}
        </div>
      </div>
      <div ref={ref} style={{ position: 'relative', marginTop: 6 }}>
        {width > 0 ? (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={`${title}${subtitle ? ` — ${subtitle}` : ''}`}
            onPointerMove={(e) => {
              const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
              setHoverX(e.clientX - rect.left);
            }}
            onPointerLeave={() => setHoverX(null)}
            style={{ display: 'block', touchAction: 'none' }}
          >
            {yTicks.map((v) => (
              <g key={`y${v}`}>
                <line x1={PAD.left} x2={PAD.left + plotW} y1={y(v)} y2={y(v)} stroke="var(--grid)" strokeWidth={1} />
                <text x={PAD.left - 6} y={y(v) + 3.5} textAnchor="end" fontSize={10} fill="var(--muted)" className="num">
                  {format(v)}
                </text>
              </g>
            ))}
            <line
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={PAD.top + plotH}
              y2={PAD.top + plotH}
              stroke="var(--axis)"
              strokeWidth={1}
            />
            {xTicks.map((t) => (
              <text key={`x${t}`} x={x(t)} y={height - 5} textAnchor="middle" fontSize={10} fill="var(--muted)" className="num">
                {formatClock(t).replace(/^00:/, '').replace(/\.000$/, 's')}
              </text>
            ))}
            {markers.map((m, i) => (
              <line
                key={`m${i}`}
                x1={x(m.t)}
                x2={x(m.t)}
                y1={PAD.top}
                y2={PAD.top + plotH}
                stroke={m.color}
                strokeWidth={1}
                opacity={0.6}
              >
                <title>{m.label}</title>
              </line>
            ))}
            {area && series.length === 1 && paths[0]?.fill ? (
              <path d={paths[0].fill} fill={series[0]!.color} opacity={0.1} />
            ) : null}
            {paths.map((p, i) =>
              p.line ? (
                <path
                  key={p.id}
                  d={p.line}
                  fill="none"
                  stroke={series[i]!.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ) : null,
            )}
            {now !== undefined && now > 0 && now < xMax ? (
              <line x1={x(now)} x2={x(now)} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--ink-2)" strokeWidth={1} opacity={0.35} />
            ) : null}
            {hoverT !== null && hasData ? (
              <>
                <line x1={x(hoverT)} x2={x(hoverT)} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--ink-2)" strokeWidth={1} />
                {readout.map((r) => (
                  <circle
                    key={r.series.id}
                    cx={x(hoverT)}
                    cy={y(r.value!)}
                    r={4}
                    fill={r.series.color}
                    stroke="var(--surface)"
                    strokeWidth={2}
                  />
                ))}
              </>
            ) : null}
            {!hasData ? (
              <text x={PAD.left + plotW / 2} y={PAD.top + plotH / 2} textAnchor="middle" fontSize={11} fill="var(--muted)">
                {empty}
              </text>
            ) : null}
          </svg>
        ) : (
          <div style={{ height }} />
        )}
        {hoverT !== null && readout.length > 0 ? (
          <div
            className="tooltip"
            style={{
              left: Math.min(Math.max(0, x(hoverT) + 12), Math.max(0, width - 170)),
              top: 4,
            }}
          >
            <div className="muted num" style={{ marginBottom: 3 }}>
              {formatClock(hoverT)}
            </div>
            {readout.map((r) => (
              <div key={r.series.id} className="tooltip-row">
                <span className="legend-key">
                  <span className="legend-line" style={{ background: r.series.color }} />
                  <span className="ink-2">{r.series.label}</span>
                </span>
                <strong>{format(r.value!)}</strong>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {series.length > 1 ? (
        <div className="legend">
          {series.map((s) => (
            <span key={s.id} className="legend-key">
              <span className="legend-line" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Value of a series at time t: the last change for step series, the nearest point otherwise. */
function valueAt(series: Series, t: number): number | undefined {
  const points = series.points;
  if (points.length === 0) return undefined;
  if (series.step) {
    let value: number | undefined;
    for (const p of points) {
      if (p.t > t) break;
      value = p.value;
    }
    return value;
  }
  let best = points[0]!;
  for (const p of points) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
  return Math.abs(best.t - t) <= Math.max(1000, t * 0.05) ? best.value : undefined;
}
