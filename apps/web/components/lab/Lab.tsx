'use client';

import { useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { useLab, type Theme } from '@/lib/store';
import { decodeSpec, sharedTokenFromLocation } from '@/lib/share';
import { loadLastSession } from '@/lib/persistence';
import { STARTER_SCENARIO } from '@/lib/starter';
import { Canvas } from '@/components/canvas/Canvas';
import { BottomPanel } from '@/components/panels/BottomPanel';
import { Inspector } from '@/components/inspector/Inspector';
import { TopBar } from './TopBar';
import { Sidebar } from './Sidebar';
import { Timeline } from './Timeline';
import { ToastProvider, useToast } from './Toast';
import { Views } from './Views';

export function Lab() {
  return (
    <ToastProvider>
      <ReactFlowProvider>
        <LabFrame />
      </ReactFlowProvider>
    </ToastProvider>
  );
}

function LabFrame() {
  const view = useLab((s) => s.view);
  const bottomOpen = useLab((s) => s.bottomOpen);
  const toast = useToast();

  useStartup(toast);
  useShortcuts();

  return (
    <div className="lab" data-testid="lab">
      <TopBar />
      <Sidebar />
      {view === 'lab' ? (
        <>
          <main className={`main${bottomOpen ? '' : ' dock-collapsed'}`}>
            <Canvas />
            <Timeline />
            <BottomPanel />
          </main>
          <Inspector />
        </>
      ) : (
        <Views />
      )}
    </div>
  );
}

/** Theme, engine, and the first scenario: a shared link wins, then the last session, then the starter. */
function useStartup(toast: (message: string) => void): void {
  useEffect(() => {
    const lab = useLab.getState();
    try {
      const theme = localStorage.getItem('distlab-theme') as Theme | null;
      if (theme === 'light' || theme === 'dark' || theme === 'system') lab.setTheme(theme);
    } catch {
      // Storage unavailable: follow the system theme.
    }
    const disconnect = lab.connect();
    let cancelled = false;
    void (async () => {
      const token = sharedTokenFromLocation();
      if (token) {
        const decoded = await decodeSpec(token);
        if (cancelled) return;
        if ('spec' in decoded) {
          lab.loadSpec(decoded.spec);
          toast(`Opened shared scenario “${decoded.spec.name}”`);
          history.replaceState(null, '', window.location.pathname);
          return;
        }
        toast('That share link could not be read; opening your last session instead.');
      }
      const last = await loadLastSession();
      if (cancelled) return;
      lab.loadSpec(last ?? STARTER_SCENARIO);
    })();
    return () => {
      cancelled = true;
      disconnect();
    };
  }, [toast]);
}

function useShortcuts(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      const lab = useLab.getState();
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 'z') {
        if (typing) return;
        event.preventDefault();
        if (event.shiftKey) lab.redo();
        else lab.undo();
        return;
      }
      if (typing || mod || event.altKey) return;
      switch (event.key) {
        case ' ':
          event.preventDefault();
          lab.togglePlay();
          return;
        case 'ArrowRight':
          event.preventDefault();
          lab.step(event.shiftKey ? 10 : 1);
          return;
        case 'ArrowLeft':
          event.preventDefault();
          lab.back(event.shiftKey ? 10 : 1);
          return;
        case 'r':
        case 'R':
          lab.reset();
          return;
        case 'e':
        case 'E':
          lab.toEnd();
          return;
        case 'Escape':
          lab.select(null);
          return;
        case 'Delete':
        case 'Backspace': {
          const selection = lab.selection;
          if (selection?.kind === 'node') lab.removeNode(selection.id);
          else if (selection?.kind === 'link') lab.removeLink(selection.id);
          else if (selection?.kind === 'fault') {
            lab.removeFault(selection.id);
            lab.select(null);
          } else if (selection?.kind === 'workload') {
            lab.removeWorkload(selection.id);
            lab.select(null);
          }
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
