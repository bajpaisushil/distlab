import type { SimEvent } from '@distlab/shared';
import type { TelemetryModule } from './types.js';

export interface ReplicaTelemetry {
  readonly replicaId: string;
  readonly primaryId: string;
  readonly applied: number;
  readonly maxLagMs: number;
  readonly meanLagMs: number;
  readonly reads: number;
  readonly staleReads: number;
  readonly staleRate: number;
  /** Mean replication lag of records applied in each window. */
  readonly lag: readonly { readonly t: number; readonly value: number }[];
}

export interface CacheTelemetry {
  readonly nodeId: string;
  readonly hits: number;
  readonly misses: number;
  readonly hitRatio: number;
  readonly fills: number;
  readonly evictions: number;
  readonly coalesced: number;
  readonly invalidations: number;
  readonly hitRatioOverTime: readonly { readonly t: number; readonly value: number }[];
}

export interface DataTelemetry {
  readonly reads: number;
  readonly writes: number;
  readonly staleReads: number;
  readonly versionRegressions: number;
  readonly duplicateWritesApplied: number;
  readonly duplicateWritesSuppressed: number;
  /** Requests each storage node actually served — reads and writes. */
  readonly storageLoad: Record<string, number>;
  readonly replicas: readonly ReplicaTelemetry[];
  readonly caches: readonly CacheTelemetry[];
}

const round = (value: number) => Math.round(value * 100) / 100;

export const dataTelemetry: TelemetryModule<DataTelemetry> = {
  name: 'data',
  levels: {
    DB_READ: 'debug',
    DB_WRITE: 'debug',
    REPLICATION: 'debug',
    REPLICATION_APPLIED: 'debug',
    STALE_READ: 'warn',
    VERSION_REGRESSION: 'error',
    CACHE_HIT: 'debug',
    CACHE_MISS: 'debug',
    CACHE_FILL: 'debug',
    CACHE_INVALIDATED: 'debug',
    CACHE_EVICTED: 'debug',
    CACHE_COALESCED: 'info',
    DUPLICATE_WRITE_SUPPRESSED: 'info',
    DUPLICATE_WRITE_APPLIED: 'error',
  },
  describe(event) {
    switch (event.type) {
      case 'DB_READ': {
        const p = (event as SimEvent<'DB_READ'>).payload;
        return `${p.nodeId} read ${p.key} → v${p.version}${p.stale ? ' (stale)' : ''} for ${p.requestId} (${round(p.latency)}ms)`;
      }
      case 'DB_WRITE': {
        const p = (event as SimEvent<'DB_WRITE'>).payload;
        return `${p.nodeId} wrote ${p.key} → v${p.version} for ${p.requestId} (${round(p.latency)}ms)`;
      }
      case 'REPLICATION': {
        const p = (event as SimEvent<'REPLICATION'>).payload;
        return `${p.primaryId} ${p.retransmit ? 're-sent' : 'shipped'} LSN ${p.lsn} (${p.key} v${p.version}) to ${p.replicaId}`;
      }
      case 'REPLICATION_APPLIED': {
        const p = (event as SimEvent<'REPLICATION_APPLIED'>).payload;
        return `${p.replicaId} applied LSN ${p.lsn} (${p.key} v${p.version}) ${round(p.lagMs)}ms after the write; ${p.behindRecords} still behind`;
      }
      case 'STALE_READ': {
        const p = (event as SimEvent<'STALE_READ'>).payload;
        return `${p.replicaId} served stale ${p.key}: v${p.readVersion} while ${p.primaryId} had v${p.latestVersion}, written ${round(p.stalenessMs)}ms ago`;
      }
      case 'VERSION_REGRESSION': {
        const p = (event as SimEvent<'VERSION_REGRESSION'>).payload;
        return `${p.replicaId} rolled ${p.key} back from v${p.fromVersion} to v${p.toVersion} — LSN ${p.lsn} arrived out of order`;
      }
      case 'CACHE_HIT': {
        const p = (event as SimEvent<'CACHE_HIT'>).payload;
        return `${p.nodeId} hit ${p.key} (v${p.version}, ${round(p.ageMs)}ms old)`;
      }
      case 'CACHE_MISS': {
        const p = (event as SimEvent<'CACHE_MISS'>).payload;
        return `${p.nodeId} missed ${p.key} (${p.reason})`;
      }
      case 'CACHE_FILL': {
        const p = (event as SimEvent<'CACHE_FILL'>).payload;
        return `${p.nodeId} cached ${p.key} v${p.version}`;
      }
      case 'CACHE_INVALIDATED': {
        const p = (event as SimEvent<'CACHE_INVALIDATED'>).payload;
        return `${p.nodeId} invalidated ${p.key} on write`;
      }
      case 'CACHE_EVICTED': {
        const p = (event as SimEvent<'CACHE_EVICTED'>).payload;
        return `${p.nodeId} evicted ${p.key} (least recently used)`;
      }
      case 'CACHE_COALESCED': {
        const p = (event as SimEvent<'CACHE_COALESCED'>).payload;
        return `${p.nodeId}: ${p.requestId} waits on ${p.waitingOn}'s fill of ${p.key} instead of hitting the database`;
      }
      case 'DUPLICATE_WRITE_SUPPRESSED': {
        const p = (event as SimEvent<'DUPLICATE_WRITE_SUPPRESSED'>).payload;
        return `${p.nodeId} recognised a repeat of ${p.requestId} and did not write ${p.key} again`;
      }
      case 'DUPLICATE_WRITE_APPLIED': {
        const p = (event as SimEvent<'DUPLICATE_WRITE_APPLIED'>).payload;
        return `${p.nodeId} applied ${p.requestId}'s write to ${p.key} twice (v${p.firstVersion}, then v${p.secondVersion})`;
      }
      default:
        return undefined;
    }
  },
  record(event, metrics) {
    switch (event.type) {
      case 'DB_READ': {
        const p = (event as SimEvent<'DB_READ'>).payload;
        metrics.counter('db.reads').add(1, p.nodeId);
        metrics.histogram(`db.${p.nodeId}.read`).record(p.latency);
        return;
      }
      case 'DB_WRITE': {
        const p = (event as SimEvent<'DB_WRITE'>).payload;
        metrics.counter('db.writes').add(1, p.nodeId);
        metrics.histogram(`db.${p.nodeId}.write`).record(p.latency);
        return;
      }
      case 'REPLICATION_APPLIED': {
        const p = (event as SimEvent<'REPLICATION_APPLIED'>).payload;
        metrics.set('data.replicas').add(`${p.replicaId}|${p.primaryId}`);
        metrics.histogram(`data.lag.${p.replicaId}`).record(p.lagMs);
        metrics.timeSeries(`data.lag.${p.replicaId}`).record(event.at, p.lagMs);
        return;
      }
      case 'STALE_READ': {
        const p = (event as SimEvent<'STALE_READ'>).payload;
        metrics.counter('data.stale').add(1, p.replicaId);
        metrics.set('data.replicas').add(`${p.replicaId}|${p.primaryId}`);
        return;
      }
      case 'VERSION_REGRESSION':
        metrics.counter('data.regressions').add(1, (event as SimEvent<'VERSION_REGRESSION'>).payload.replicaId);
        return;
      case 'DUPLICATE_WRITE_APPLIED':
        metrics.counter('data.duplicates.applied').add();
        return;
      case 'DUPLICATE_WRITE_SUPPRESSED':
        metrics.counter('data.duplicates.suppressed').add();
        return;
      case 'CACHE_HIT':
      case 'CACHE_MISS':
      case 'CACHE_FILL':
      case 'CACHE_EVICTED':
      case 'CACHE_COALESCED':
      case 'CACHE_INVALIDATED': {
        const nodeId = (event as SimEvent<'CACHE_HIT'>).payload.nodeId;
        const kind = event.type.slice('CACHE_'.length).toLowerCase();
        metrics.set('data.caches').add(nodeId);
        metrics.counter(`data.cache.${kind}`).add(1, nodeId);
        if (event.type === 'CACHE_HIT' || event.type === 'CACHE_MISS') {
          metrics.timeSeries(`data.cache.${nodeId}.lookups`).record(event.at, event.type === 'CACHE_HIT' ? 1 : 0);
        }
        return;
      }
      default:
        return;
    }
  },
  snapshot(metrics) {
    const reads = metrics.counter('db.reads');
    const stale = metrics.counter('data.stale').byLabel();
    const readsBy = reads.byLabel();
    const replicas: ReplicaTelemetry[] = [...metrics.set('data.replicas').values()].sort().map((key) => {
      const [replicaId, primaryId] = key.split('|') as [string, string];
      const lag = metrics.histogram(`data.lag.${replicaId}`).percentiles();
      const replicaReads = readsBy[replicaId] ?? 0;
      return {
        replicaId,
        primaryId,
        applied: lag.count,
        maxLagMs: lag.max,
        meanLagMs: lag.mean,
        reads: replicaReads,
        staleReads: stale[replicaId] ?? 0,
        staleRate: replicaReads === 0 ? 0 : (stale[replicaId] ?? 0) / replicaReads,
        lag: metrics.timeSeries(`data.lag.${replicaId}`).meanPerWindow(),
      };
    });
    const count = (kind: string, id: string) => metrics.counter(`data.cache.${kind}`).byLabel()[id] ?? 0;
    const caches: CacheTelemetry[] = [...metrics.set('data.caches').values()].sort().map((nodeId) => {
      const hits = count('hit', nodeId);
      const misses = count('miss', nodeId);
      return {
        nodeId,
        hits,
        misses,
        hitRatio: hits + misses === 0 ? 0 : hits / (hits + misses),
        fills: count('fill', nodeId),
        evictions: count('evicted', nodeId),
        coalesced: count('coalesced', nodeId),
        invalidations: count('invalidated', nodeId),
        hitRatioOverTime: metrics.timeSeries(`data.cache.${nodeId}.lookups`).meanPerWindow(),
      };
    });
    const writesBy = metrics.counter('db.writes').byLabel();
    const storageLoad: Record<string, number> = {};
    for (const id of new Set([...Object.keys(readsBy), ...Object.keys(writesBy)])) {
      storageLoad[id] = (readsBy[id] ?? 0) + (writesBy[id] ?? 0);
    }
    return {
      reads: reads.total,
      writes: metrics.counter('db.writes').total,
      staleReads: metrics.counter('data.stale').total,
      versionRegressions: metrics.counter('data.regressions').total,
      duplicateWritesApplied: metrics.counter('data.duplicates.applied').total,
      duplicateWritesSuppressed: metrics.counter('data.duplicates.suppressed').total,
      storageLoad,
      replicas,
      caches,
    };
  },
};
