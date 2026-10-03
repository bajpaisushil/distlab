'use client';

import { create } from 'zustand';
import {
  validateSimulationSpec,
  type FaultSpec,
  type LinkId,
  type LinkSpec,
  type NodeId,
  type NodeType,
  type SimulationSpec,
  type SpecIssue,
  type WorkloadSpec,
} from '@distlab/shared';
import type { Experiment } from '@distlab/scenarios';
import { EngineClient } from './engine/client';
import type { Frame, Query, QueryResults } from './engine/protocol';
import * as edit from './spec-edit';
import { autoLayout } from './layout';
import { saveLastSession } from './persistence';

export type Selection =
  | { readonly kind: 'node'; readonly id: NodeId }
  | { readonly kind: 'link'; readonly id: LinkId }
  | { readonly kind: 'workload'; readonly id: string }
  | { readonly kind: 'fault'; readonly id: string }
  | { readonly kind: 'event'; readonly id: string }
  | { readonly kind: 'trace'; readonly id: string }
  | { readonly kind: 'scenario' }
  | null;

export type BottomTab = 'events' | 'logs' | 'metrics' | 'traces' | 'explain';
export type View = 'lab' | 'library' | 'compare' | 'experiments';
export type Theme = 'system' | 'light' | 'dark';

/** Playback speeds, as virtual milliseconds per real millisecond. */
export const SPEEDS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 100] as const;

const HISTORY_LIMIT = 100;
const RELOAD_DEBOUNCE_MS = 120;

interface LabState {
  readonly spec: SimulationSpec;
  readonly issues: readonly SpecIssue[];
  readonly engineError: string | undefined;
  readonly frame: Frame | undefined;
  readonly speed: number;
  readonly selection: Selection;
  readonly view: View;
  /** An experiment handed to the What-if view to load — from the AI copilot, never run automatically. */
  readonly pendingExperiment: Experiment | null;
  readonly bottomTab: BottomTab;
  readonly bottomOpen: boolean;
  readonly theme: Theme;
  readonly past: readonly SimulationSpec[];
  readonly future: readonly SimulationSpec[];

  connect(): () => void;
  query<K extends Query['kind']>(query: Extract<Query, { kind: K }>): Promise<QueryResults[K]>;

  // design
  loadSpec(spec: SimulationSpec, options?: { keepTime?: boolean }): void;
  addNode(type: NodeType, position?: { x: number; y: number }): NodeId;
  updateNode(id: NodeId, patch: edit.NodePatch): void;
  removeNode(id: NodeId): void;
  moveNode(id: NodeId, position: { x: number; y: number }): void;
  connectNodes(from: NodeId, to: NodeId): LinkId | undefined;
  updateLink(id: LinkId, patch: Partial<LinkSpec>): void;
  removeLink(id: LinkId): void;
  addWorkload(clientId: NodeId): string;
  updateWorkload(id: string, patch: Partial<WorkloadSpec>): void;
  removeWorkload(id: string): void;
  addFault(fault: FaultSpec): string;
  updateFault(id: string, patch: Record<string, unknown>): void;
  removeFault(id: string): void;
  updateScenario(patch: Partial<Pick<SimulationSpec, 'name' | 'description' | 'seed' | 'durationMs'>>): void;
  undo(): void;
  redo(): void;

  // playback
  play(): void;
  pause(): void;
  togglePlay(): void;
  step(count?: number): void;
  back(count?: number): void;
  seek(position: number): void;
  seekTime(time: number): void;
  toEnd(): void;
  reset(): void;
  setSpeed(speed: number): void;

  // ui
  select(selection: Selection): void;
  setView(view: View): void;
  /** Opens the What-if view with this experiment loaded, for the user to inspect and run. */
  proposeExperiment(experiment: Experiment): void;
  takePendingExperiment(): Experiment | null;
  setBottomTab(tab: BottomTab): void;
  toggleBottom(open?: boolean): void;
  setTheme(theme: Theme): void;
}

let engine: EngineClient | undefined;
let reloadTimer: ReturnType<typeof setTimeout> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

export const useLab = create<LabState>()((set, get) => {
  /** Applies an edit: history, validation, and — unless it is layout only — a rebuild of the run. */
  function commit(next: SimulationSpec, options: { record?: boolean; keepTime?: boolean } = {}): void {
    const current = get().spec;
    if (next === current) return;
    const validation = validateSimulationSpec(next);
    const layoutOnly = edit.sameSimulation(current, next);
    set((state) => ({
      spec: next,
      issues: validation.errors,
      past: options.record === false ? state.past : [...state.past, current].slice(-HISTORY_LIMIT),
      future: options.record === false ? state.future : [],
    }));
    if (!layoutOnly && validation.valid) scheduleReload(next, options.keepTime ?? true);
    scheduleSave(next);
  }

  function scheduleReload(spec: SimulationSpec, keepTime: boolean): void {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => engine?.load(spec, keepTime), RELOAD_DEBOUNCE_MS);
  }

  function scheduleSave(spec: SimulationSpec): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void saveLastSession(spec), 600);
  }

  return {
    spec: edit.emptySpec(),
    issues: [],
    engineError: undefined,
    frame: undefined,
    speed: 1,
    selection: null,
    view: 'lab',
    pendingExperiment: null,
    bottomTab: 'metrics',
    bottomOpen: true,
    theme: 'system',
    past: [],
    future: [],

    connect() {
      if (engine) return () => {};
      engine = new EngineClient({
        onFrame: (frame) => set({ frame, engineError: undefined }),
        onInvalid: (issues) => set({ issues }),
        onError: (message) => set({ engineError: message }),
      });
      const { spec } = get();
      if (validateSimulationSpec(spec).valid) engine.load(spec, false);
      return () => {
        engine?.dispose();
        engine = undefined;
      };
    },

    query(query) {
      if (!engine) return Promise.reject(new Error('engine not connected'));
      return engine.query(query);
    },

    loadSpec(spec, options = {}) {
      const placed = { ...spec, layout: autoLayout(spec) };
      const validation = validateSimulationSpec(placed);
      set({ spec: placed, issues: validation.errors, past: [], future: [], selection: null });
      if (validation.valid) {
        if (reloadTimer) clearTimeout(reloadTimer);
        engine?.load(placed, options.keepTime ?? false);
      }
      scheduleSave(placed);
    },

    addNode(type, position) {
      const result = edit.addNode(get().spec, type, position);
      commit(result.spec);
      set({ selection: { kind: 'node', id: result.id } });
      return result.id;
    },
    updateNode: (id, patch) => commit(edit.updateNode(get().spec, id, patch)),
    removeNode(id) {
      commit(edit.removeNode(get().spec, id));
      set({ selection: null });
    },
    moveNode: (id, position) => commit(edit.moveNode(get().spec, id, position), { record: false }),
    connectNodes(from, to) {
      const result = edit.addLink(get().spec, from, to);
      if (!result) return undefined;
      commit(result.spec);
      return result.id;
    },
    updateLink: (id, patch) => commit(edit.updateLink(get().spec, id, patch)),
    removeLink(id) {
      commit(edit.removeLink(get().spec, id));
      set({ selection: null });
    },
    addWorkload(clientId) {
      const result = edit.addWorkload(get().spec, clientId);
      commit(result.spec);
      return result.id;
    },
    updateWorkload: (id, patch) => commit(edit.updateWorkload(get().spec, id, patch)),
    removeWorkload: (id) => commit(edit.removeWorkload(get().spec, id)),
    addFault(fault) {
      const result = edit.addFault(get().spec, fault);
      commit(result.spec);
      return result.id;
    },
    updateFault: (id, patch) => commit(edit.updateFault(get().spec, id, patch)),
    removeFault: (id) => commit(edit.removeFault(get().spec, id)),
    updateScenario: (patch) => commit({ ...get().spec, ...patch }),

    undo() {
      const { past, spec, future } = get();
      const previous = past[past.length - 1];
      if (!previous) return;
      set({ past: past.slice(0, -1), future: [spec, ...future].slice(0, HISTORY_LIMIT) });
      commit(previous, { record: false });
    },
    redo() {
      const { past, spec, future } = get();
      const next = future[0];
      if (!next) return;
      set({ future: future.slice(1), past: [...past, spec].slice(-HISTORY_LIMIT) });
      commit(next, { record: false });
    },

    play: () => engine?.play(get().speed),
    pause: () => engine?.pause(),
    togglePlay() {
      const frame = get().frame;
      if (frame?.playing) engine?.pause();
      else if (frame?.status === 'completed') {
        engine?.reset();
        engine?.play(get().speed);
      } else engine?.play(get().speed);
    },
    step: (count = 1) => engine?.step(count),
    back: (count = 1) => engine?.back(count),
    seek: (position) => engine?.seek(position),
    seekTime: (time) => engine?.seekTime(time),
    toEnd: () => engine?.toEnd(),
    reset: () => engine?.reset(),
    setSpeed(speed) {
      set({ speed });
      engine?.setSpeed(speed);
    },

    select: (selection) => set({ selection }),
    setView: (view) => set({ view }),
    proposeExperiment: (experiment) => set({ pendingExperiment: experiment, view: 'experiments' }),
    takePendingExperiment() {
      const pending = get().pendingExperiment;
      if (pending) set({ pendingExperiment: null });
      return pending;
    },
    setBottomTab: (tab) => set({ bottomTab: tab, bottomOpen: true }),
    toggleBottom: (open) => set((state) => ({ bottomOpen: open ?? !state.bottomOpen })),
    setTheme(theme) {
      set({ theme });
      try {
        localStorage.setItem('distlab-theme', theme);
      } catch {
        // Storage can be unavailable; the choice still applies for this session.
      }
      if (theme === 'system') document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', theme);
    },
  };
});
