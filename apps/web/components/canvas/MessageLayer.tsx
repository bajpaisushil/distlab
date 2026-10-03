'use client';

import { useEffect, useRef } from 'react';
import { useStoreApi } from '@xyflow/react';
import { useLab } from '@/lib/store';
import type { Frame } from '@/lib/engine/protocol';
import { linkSegment, type Box } from './geometry';

const DROP_FLASH_MS = 700;
const MAX_EXTRAPOLATE_MS = 120;

interface Flash {
  readonly x: number;
  readonly y: number;
  readonly bornAt: number;
}

/**
 * Draws every message on the wire as a dot travelling along its link.
 *
 * Positions come straight from the engine — send time and delivery time of
 * each in-flight message — and virtual time is interpolated between frames at
 * the playback speed, so motion is smooth without the UI ever inventing where
 * a message is. Drops flash where they happened. Drawn on a canvas in one
 * pass: hundreds of messages cost one paint, not hundreds of DOM nodes.
 */
export function MessageLayer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const flow = useStoreApi();

  useEffect(() => {
    let raf = 0;
    let seen: Frame | undefined;
    let seenAt = 0;
    let palette = readPalette();
    const flashes: Flash[] = [];
    const flashed = new Set<string>();

    const boxOf = (id: string): Box | undefined => {
      const node = flow.getState().nodeLookup.get(id);
      if (!node) return undefined;
      return {
        x: node.internals.positionAbsolute.x,
        y: node.internals.positionAbsolute.y,
        width: node.measured.width ?? 168,
        height: node.measured.height ?? 90,
      };
    };

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      const parent = canvas?.parentElement;
      if (!canvas || !parent) return;
      const dpr = window.devicePixelRatio || 1;
      const width = parent.clientWidth;
      const height = parent.clientHeight;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const frame = useLab.getState().frame;
      if (!frame) return;
      const realNow = performance.now();
      if (frame !== seen) {
        seen = frame;
        seenAt = realNow;
        palette = readPalette();
        for (const event of frame.recent) {
          if (event.type !== 'MESSAGE_DROPPED' || flashed.has(event.id)) continue;
          flashed.add(event.id);
          // Only flash drops that are actually new on screen, not history.
          if (frame.now - event.at > 400 * Math.max(1, frame.speed)) continue;
          const payload = event.payload as { source: string; destination: string };
          const a = boxOf(payload.source);
          const b = boxOf(payload.destination);
          if (!a || !b) continue;
          const segment = linkSegment(a, b);
          flashes.push({
            x: segment.from.x + (segment.to.x - segment.from.x) * 0.35,
            y: segment.from.y + (segment.to.y - segment.from.y) * 0.35,
            bornAt: realNow,
          });
        }
        if (flashed.size > 5000) flashed.clear();
      }

      const [tx, ty, zoom] = flow.getState().transform;
      const virtualNow = frame.playing
        ? frame.now + Math.min(realNow - seenAt, MAX_EXTRAPOLATE_MS) * frame.speed
        : frame.now;
      const radius = Math.max(2.5, Math.min(5, 4 * zoom));

      for (const message of frame.inFlight) {
        const a = boxOf(message.source);
        const b = boxOf(message.destination);
        if (!a || !b) continue;
        const { from, to } = linkSegment(a, b);
        const span = Math.max(1e-6, message.deliverAt - message.sentAt);
        const progress = Math.max(0, Math.min(1, (virtualNow - message.sentAt) / span));
        const x = (from.x + (to.x - from.x) * progress) * zoom + tx;
        const y = (from.y + (to.y - from.y) * progress) * zoom + ty;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = colourFor(message.kind, message.status, palette);
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = palette.surface;
        ctx.stroke();
        if (message.duplicate) {
          ctx.beginPath();
          ctx.arc(x, y, radius + 3, 0, Math.PI * 2);
          ctx.lineWidth = 1.25;
          ctx.strokeStyle = palette.warning;
          ctx.stroke();
        }
      }

      for (let i = flashes.length - 1; i >= 0; i--) {
        const flash = flashes[i]!;
        const age = realNow - flash.bornAt;
        if (age > DROP_FLASH_MS) {
          flashes.splice(i, 1);
          continue;
        }
        const alpha = 1 - age / DROP_FLASH_MS;
        const x = flash.x * zoom + tx;
        const y = flash.y * zoom + ty;
        const s = 5;
        ctx.globalAlpha = alpha;
        ctx.lineWidth = 2;
        ctx.strokeStyle = palette.critical;
        ctx.beginPath();
        ctx.moveTo(x - s, y - s);
        ctx.lineTo(x + s, y + s);
        ctx.moveTo(x + s, y - s);
        ctx.lineTo(x - s, y + s);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [flow]);

  return <canvas ref={canvasRef} className="message-layer" aria-hidden="true" />;
}

interface Palette {
  surface: string;
  request: string;
  ok: string;
  failure: string;
  protocol: string;
  warning: string;
  critical: string;
}

function readPalette(): Palette {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string) => style.getPropertyValue(name).trim() || '#888';
  return {
    surface: v('--surface'),
    request: v('--series-1'),
    ok: v('--series-3'),
    failure: v('--critical'),
    protocol: v('--series-7'),
    warning: v('--warning'),
    critical: v('--critical'),
  };
}

function colourFor(kind: string, status: string | undefined, palette: Palette): string {
  if (kind === 'REQUEST') return palette.request;
  if (kind === 'RESPONSE') return status === 'ok' ? palette.ok : palette.failure;
  return palette.protocol;
}
