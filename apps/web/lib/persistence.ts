import type { SimulationSpec } from '@distlab/shared';

/**
 * Local persistence in IndexedDB: saved designs and the last open scenario.
 * Nothing leaves the browser. Every call tolerates storage being unavailable
 * (private windows, blocked site data) by quietly doing nothing.
 */

const DB_NAME = 'distlab';
const DB_VERSION = 1;
const DESIGNS = 'designs';
const SESSION = 'session';

export interface SavedDesign {
  readonly id: string;
  readonly name: string;
  readonly savedAt: number;
  readonly spec: SimulationSpec;
}

let opening: Promise<IDBDatabase | undefined> | undefined;

function open(): Promise<IDBDatabase | undefined> {
  if (opening) return opening;
  opening = new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(DESIGNS)) db.createObjectStore(DESIGNS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(SESSION)) db.createObjectStore(SESSION);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
  return opening;
}

function run<T>(store: string, mode: IDBTransactionMode, body: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return open().then(
    (db) =>
      new Promise((resolve) => {
        if (!db) return resolve(undefined);
        try {
          const request = body(db.transaction(store, mode).objectStore(store));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      }),
  );
}

export async function listDesigns(): Promise<SavedDesign[]> {
  const all = (await run<SavedDesign[]>(DESIGNS, 'readonly', (s) => s.getAll())) ?? [];
  return all.sort((a, b) => b.savedAt - a.savedAt);
}

export async function saveDesign(spec: SimulationSpec, savedAt: number): Promise<SavedDesign> {
  const design: SavedDesign = { id: spec.id, name: spec.name, savedAt, spec };
  await run(DESIGNS, 'readwrite', (s) => s.put(design));
  return design;
}

export async function deleteDesign(id: string): Promise<void> {
  await run(DESIGNS, 'readwrite', (s) => s.delete(id));
}

export async function saveLastSession(spec: SimulationSpec): Promise<void> {
  await run(SESSION, 'readwrite', (s) => s.put(spec, 'last'));
}

export async function loadLastSession(): Promise<SimulationSpec | undefined> {
  return run<SimulationSpec>(SESSION, 'readonly', (s) => s.get('last'));
}
