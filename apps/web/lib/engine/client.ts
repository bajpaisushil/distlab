import type { SimulationSpec, SpecIssue } from '@distlab/shared';
import type { Frame, Query, QueryResults, WorkerRequest, WorkerResponse } from './protocol';

export interface EngineHandlers {
  onFrame(frame: Frame): void;
  onInvalid(issues: readonly SpecIssue[]): void;
  onError(message: string): void;
}

/**
 * Main-thread handle on the simulation worker. Commands are fire-and-forget
 * (their effect arrives as the next frame); queries return promises.
 */
export class EngineClient {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  constructor(private readonly handlers: EngineHandlers) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'distlab-engine' });
    this.worker.onmessage = (message: MessageEvent<WorkerResponse>) => this.receive(message.data);
    this.worker.onerror = (event) => handlers.onError(event.message || 'simulation worker crashed');
  }

  load(spec: SimulationSpec, keepTime: boolean): void {
    this.send({ type: 'load', spec, keepTime });
  }

  play(speed: number): void {
    this.send({ type: 'play', speed });
  }

  pause(): void {
    this.send({ type: 'pause' });
  }

  setSpeed(speed: number): void {
    this.send({ type: 'setSpeed', speed });
  }

  step(count = 1): void {
    this.send({ type: 'step', count });
  }

  back(count = 1): void {
    this.send({ type: 'back', count });
  }

  seek(position: number): void {
    this.send({ type: 'seek', position });
  }

  seekTime(time: number): void {
    this.send({ type: 'seekTime', time });
  }

  toEnd(): void {
    this.send({ type: 'toEnd' });
  }

  reset(): void {
    this.send({ type: 'reset' });
  }

  query<K extends Query['kind']>(query: Extract<Query, { kind: K }>): Promise<QueryResults[K]> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.send({ type: 'query', id, query });
    });
  }

  dispose(): void {
    this.worker.terminate();
    for (const { reject } of this.pending.values()) reject(new Error('engine disposed'));
    this.pending.clear();
  }

  private send(request: WorkerRequest): void {
    this.worker.postMessage(request);
  }

  private receive(response: WorkerResponse): void {
    switch (response.type) {
      case 'frame':
        this.handlers.onFrame(response.frame);
        return;
      case 'invalid':
        this.handlers.onInvalid(response.issues);
        return;
      case 'result': {
        const waiter = this.pending.get(response.id);
        this.pending.delete(response.id);
        waiter?.resolve(response.result);
        return;
      }
      case 'error': {
        if (response.id !== undefined) {
          const waiter = this.pending.get(response.id);
          this.pending.delete(response.id);
          waiter?.reject(new Error(response.message));
        } else {
          this.handlers.onError(response.message);
        }
      }
    }
  }
}
