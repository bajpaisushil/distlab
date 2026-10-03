/// <reference lib="webworker" />
/**
 * The simulation's home off the main thread.
 *
 * The engine itself has no notion of real time; this file is the only place
 * that does. Playback converts wall-clock time into virtual time at the chosen
 * speed, bounded per tick so a dense burst of events never freezes the
 * worker, and frames go out at most ~30 times a second however many events
 * were processed in between.
 */
import { LabSession } from './session';
import type { WorkerRequest, WorkerResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const TICK_MS = 16;
const FRAME_MS = 33;
const MAX_CATCH_UP_MS = 250;
const EVENT_BUDGET_PER_TICK = 30_000;

const session = new LabSession();
let playing = false;
let speed = 1;
let timer: ReturnType<typeof setTimeout> | undefined;
let lastTick = 0;
let lastFrame = 0;

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function sendFrame(): void {
  if (session.loaded) post({ type: 'frame', frame: session.frame(playing, speed) });
}

function schedule(): void {
  if (timer === undefined) timer = setTimeout(tick, TICK_MS);
}

function tick(): void {
  timer = undefined;
  if (!playing || !session.loaded) return;
  const now = performance.now();
  // A backgrounded tab throttles timers; don't try to make up seconds of lost time at once.
  const elapsed = Math.min(MAX_CATCH_UP_MS, now - lastTick);
  lastTick = now;
  session.advance(elapsed * speed, EVENT_BUDGET_PER_TICK);
  if (session.completed) {
    playing = false;
    sendFrame();
    return;
  }
  if (now - lastFrame >= FRAME_MS) {
    lastFrame = now;
    sendFrame();
  }
  schedule();
}

function handle(request: WorkerRequest): void {
  switch (request.type) {
    case 'load': {
      const result = session.load(request.spec, request.keepTime);
      if (!result.ok) post({ type: 'invalid', issues: result.issues });
      else sendFrame();
      return;
    }
    case 'play':
      speed = request.speed;
      if (!playing && session.loaded && !session.completed) {
        playing = true;
        lastTick = performance.now();
        schedule();
      }
      sendFrame();
      return;
    case 'pause':
      playing = false;
      sendFrame();
      return;
    case 'setSpeed':
      speed = request.speed;
      sendFrame();
      return;
    case 'step':
      playing = false;
      session.step(request.count);
      sendFrame();
      return;
    case 'back':
      playing = false;
      session.back(request.count);
      sendFrame();
      return;
    case 'seek':
      session.seek(request.position);
      sendFrame();
      return;
    case 'seekTime':
      session.seekTime(request.time);
      sendFrame();
      return;
    case 'toEnd':
      playing = false;
      session.toEnd();
      sendFrame();
      return;
    case 'reset':
      playing = false;
      session.reset();
      sendFrame();
      return;
    case 'query':
      post({ type: 'result', id: request.id, result: session.query(request.query) });
      return;
  }
}

self.onmessage = (message: MessageEvent<WorkerRequest>) => {
  const request = message.data;
  try {
    handle(request);
  } catch (error) {
    post({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
      ...(request.type === 'query' ? { id: request.id } : {}),
    });
  }
};
