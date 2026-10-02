import { EnginePreview } from './engine-preview';
import { BASELINE_SCENARIO } from './baseline-scenario';

const PHASES: { name: string; done: boolean }[] = [
  { name: 'Simulation clock, event queue, deterministic RNG', done: true },
  { name: 'Nodes, simulated network, messages', done: true },
  { name: 'Request tracing and metrics', done: true },
  { name: 'Architecture canvas', done: false },
  { name: 'Failure injection', done: false },
  { name: 'Load balancing and replication', done: false },
  { name: 'Queues, retries, circuit breakers', done: false },
  { name: 'Leader election and distributed locks', done: false },
  { name: 'Time travel and replay', done: false },
  { name: 'Scenario library', done: false },
  { name: 'Architecture comparison and what-if experiments', done: false },
  { name: 'AI copilot', done: false },
];

export default function Page() {
  return (
    <main>
      <h1>DistLab</h1>
      <p className="tagline">
        A deterministic simulation engine for distributed systems. Everything runs in your browser —
        no server, no account, no data leaving the page.
      </p>

      <p>
        The simulation is event-driven and reproducible: a scenario plus a random seed always
        produces the same run, down to individual event ids. Nothing is faked with timers, and
        nodes never call each other directly — every hop travels through a simulated network that
        can delay, drop, duplicate, reorder or partition it.
      </p>

      <p>
        The engine below ran <code>{BASELINE_SCENARIO.name}</code> when this page loaded. Reload it
        and every figure will be identical.
      </p>

      <EnginePreview />

      <h2>Build progress</h2>
      <div className="panel">
        <ul className="phases">
          {PHASES.map((phase) => (
            <li key={phase.name}>
              <span className="tick">{phase.done ? '✓' : '·'}</span>
              <span className={phase.done ? undefined : 'pending'}>{phase.name}</span>
            </li>
          ))}
        </ul>
      </div>

      <footer>
        The visual editor, failure injection, consensus algorithms and the AI explanation layer are
        not built yet. This page is a preview of the engine underneath them, not the laboratory
        interface.
      </footer>
    </main>
  );
}
