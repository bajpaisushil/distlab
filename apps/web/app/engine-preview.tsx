'use client';

import { useMemo } from 'react';
import { createSimulation } from '@distlab/simulation-engine';
import type { Trace } from '@distlab/telemetry';
import { BASELINE_SCENARIO } from './baseline-scenario';

const ms = (value: number) => `${value.toFixed(1)}ms`;
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

/**
 * Runs the baseline scenario in the browser and reports what it measured.
 *
 * Everything on screen is read back from the engine: nothing here is a
 * hard-coded figure, and running it twice produces the same numbers because
 * the scenario carries its seed.
 */
export function EnginePreview() {
  const result = useMemo(() => {
    const world = createSimulation(BASELINE_SCENARIO);
    const startedAt = performance.now();
    const run = world.run();
    const wallClockMs = performance.now() - startedAt;
    return {
      run,
      wallClockMs,
      snapshot: world.snapshot(),
      events: world.simulation.eventsProcessed,
      slowest: world.telemetry.traces.slowest(1)[0],
    };
  }, []);

  const { snapshot, run, events, wallClockMs, slowest } = result;

  return (
    <>
      <h2>Measured results</h2>
      <div className="grid">
        <Stat label="Events processed" value={events.toLocaleString()} />
        <Stat label="Simulated time" value={`${(run.endedAt / 1000).toFixed(1)}s`} />
        <Stat label="Wall clock" value={`${wallClockMs.toFixed(0)}ms`} />
        <Stat label="Requests" value={snapshot.requests.created.toLocaleString()} />
        <Stat label="Throughput" value={`${snapshot.requests.throughputPerSec.toFixed(0)}/s`} />
        <Stat label="Success rate" value={pct(snapshot.requests.successRate)} />
        <Stat label="p50 latency" value={ms(snapshot.latency.p50)} />
        <Stat label="p95 latency" value={ms(snapshot.latency.p95)} />
        <Stat label="p99 latency" value={ms(snapshot.latency.p99)} />
        <Stat label="Messages dropped" value={snapshot.messages.dropped.toLocaleString()} />
      </div>

      <h2>Per node</h2>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Node</th>
              <th className="num">Served</th>
              <th className="num">Failed</th>
              <th className="num">Rejected</th>
              <th className="num">Peak queue</th>
              <th className="num">Utilisation</th>
              <th className="num">Service p95</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.nodes.map((node) => (
              <tr key={node.id}>
                <td>{node.label}</td>
                <td className="num">{node.processed.toLocaleString()}</td>
                <td className="num">{node.failed.toLocaleString()}</td>
                <td className="num">{node.rejected.toLocaleString()}</td>
                <td className="num">{node.maxQueueDepth}</td>
                <td className="num">{pct(Math.min(1, node.utilization))}</td>
                <td className="num">
                  {node.serviceTime.count > 0 ? ms(node.serviceTime.p95) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="note">
        API 2 serves nothing: routing currently picks the first healthy downstream, because
        load-balancing strategies are a later phase. The table reports what the run actually did
        rather than what the diagram implies.
      </p>

      {slowest ? <Waterfall trace={slowest} /> : null}

      <h2>Where the failures went</h2>
      <div className="panel">
        <table>
          <tbody>
            {Object.entries(snapshot.failuresByReason).map(([reason, count]) => (
              <tr key={reason}>
                <td>request failed · {reason}</td>
                <td className="num">{count.toLocaleString()}</td>
              </tr>
            ))}
            {Object.entries(snapshot.messages.dropsByReason).map(([reason, count]) => (
              <tr key={reason}>
                <td>message dropped · {reason}</td>
                <td className="num">{count.toLocaleString()}</td>
              </tr>
            ))}
            {Object.keys(snapshot.failuresByReason).length === 0 &&
            Object.keys(snapshot.messages.dropsByReason).length === 0 ? (
              <tr>
                <td>nothing was lost in this run</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

/** The slowest trace in the run, drawn as a span waterfall. */
function Waterfall({ trace }: { trace: Trace }) {
  const total = trace.duration ?? 1;
  return (
    <>
      <h2>Slowest request · trace {trace.traceId}</h2>
      <div className="panel waterfall">
        {trace.spans.map((span, index) => {
          const offset = ((span.startedAt - trace.startedAt) / total) * 100;
          const width = ((span.duration ?? 0) / total) * 100;
          return (
            <div className="waterfall-row" key={`${span.spanId}-${index}`}>
              <span>{span.nodeId}</span>
              <span className="bar-track">
                <span className="bar" style={{ left: `${offset}%`, width: `${Math.max(width, 0.6)}%` }} />
              </span>
              <span className="num">{ms(span.duration ?? 0)}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}
