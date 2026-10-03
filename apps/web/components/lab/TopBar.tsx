'use client';

import { useRef } from 'react';
import { parseSimulationSpec, serializeSimulationSpec } from '@distlab/shared';
import { SPEEDS, useLab, type Theme, type View } from '@/lib/store';
import { shareUrl } from '@/lib/share';
import { formatClock } from '@/lib/format';
import { Icon } from '@/components/ui/icons';
import { useToast } from './Toast';

const VIEWS: readonly { id: View; label: string; icon: 'layers' | 'book' | 'compare' | 'flask' }[] = [
  { id: 'lab', label: 'Lab', icon: 'layers' },
  { id: 'library', label: 'Library', icon: 'book' },
  { id: 'compare', label: 'Compare', icon: 'compare' },
  { id: 'experiments', label: 'What-if', icon: 'flask' },
];

export function TopBar() {
  const spec = useLab((s) => s.spec);
  const frame = useLab((s) => s.frame);
  const speed = useLab((s) => s.speed);
  const view = useLab((s) => s.view);
  const theme = useLab((s) => s.theme);
  const issues = useLab((s) => s.issues);
  const canUndo = useLab((s) => s.past.length > 0);
  const canRedo = useLab((s) => s.future.length > 0);
  const lab = useLab.getState();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const playing = frame?.playing ?? false;
  const completed = frame?.status === 'completed';
  const disabled = !frame || issues.length > 0;

  const exportSpec = () => {
    const blob = new Blob([serializeSimulationSpec(spec)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'distlab-scenario.json';
    a.click();
    URL.revokeObjectURL(url);
    toast('Exported distlab-scenario.json');
  };

  const importSpec = async (file: File) => {
    const parsed = parseSimulationSpec(await file.text());
    if ('errors' in parsed) {
      toast(`Not a valid scenario: ${parsed.errors[0]?.path || 'file'} ${parsed.errors[0]?.message ?? ''}`);
      return;
    }
    lab.loadSpec(parsed.spec);
    lab.setView('lab');
    toast(`Imported “${parsed.spec.name}”`);
  };

  const share = async () => {
    const url = await shareUrl(spec);
    try {
      await navigator.clipboard.writeText(url);
      toast('Share link copied — the scenario travels in the link itself.');
    } catch {
      window.prompt('Copy this share link', url);
    }
  };

  const nextTheme: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">
          <Icon name="layers" size={14} />
        </span>
        DistLab
      </div>
      <div className="seg" role="tablist" aria-label="View">
        {VIEWS.map((v) => (
          <button key={v.id} role="tab" aria-pressed={view === v.id} onClick={() => lab.setView(v.id)} title={v.label}>
            <span className="row" style={{ gap: 5 }}>
              <Icon name={v.icon} size={14} />
              <span className="hide-narrow">{v.label}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="toolbar-sep" />
      <button className="btn icon ghost" title="Reset to start (R)" onClick={() => lab.reset()} disabled={disabled} aria-label="Reset">
        <Icon name="reset" />
      </button>
      <button className="btn icon ghost" title="Step back (←)" onClick={() => lab.back(1)} disabled={disabled} aria-label="Step back">
        <Icon name="stepBack" />
      </button>
      <button
        className="btn icon primary"
        title={playing ? 'Pause (Space)' : completed ? 'Replay from start (Space)' : 'Run (Space)'}
        onClick={() => lab.togglePlay()}
        disabled={disabled}
        aria-label={playing ? 'Pause' : 'Run'}
        data-testid="play"
      >
        <Icon name={playing ? 'pause' : 'play'} />
      </button>
      <button className="btn icon ghost" title="Step one event (→)" onClick={() => lab.step(1)} disabled={disabled} aria-label="Step">
        <Icon name="stepForward" />
      </button>
      <button className="btn icon ghost" title="Run to the end (E)" onClick={() => lab.toEnd()} disabled={disabled} aria-label="Run to end">
        <Icon name="skipEnd" />
      </button>
      <select
        className="select"
        style={{ width: 74, flex: 'none' }}
        value={speed}
        onChange={(e) => lab.setSpeed(Number(e.target.value))}
        title="Playback speed: virtual time per real time"
        aria-label="Speed"
      >
        {SPEEDS.map((s) => (
          <option key={s} value={s}>
            {s}×
          </option>
        ))}
      </select>
      <span className="mono num muted hide-narrow" style={{ minWidth: 150, whiteSpace: 'nowrap' }} data-testid="clock">
        {formatClock(frame?.now ?? 0)} / {formatClock(frame?.durationMs ?? spec.durationMs ?? 0)}
      </span>
      <div className="spacer" />
      <button className="btn icon ghost" title="Undo (⌘Z)" onClick={() => lab.undo()} disabled={!canUndo} aria-label="Undo">
        <Icon name="undo" />
      </button>
      <button className="btn icon ghost" title="Redo (⇧⌘Z)" onClick={() => lab.redo()} disabled={!canRedo} aria-label="Redo">
        <Icon name="redo" />
      </button>
      <div className="toolbar-sep" />
      <button className="btn ghost" onClick={share} title="Copy a link that contains this scenario">
        <Icon name="share" size={14} />
        <span className="hide-narrow">Share</span>
      </button>
      <button className="btn ghost" onClick={exportSpec} title="Export distlab-scenario.json">
        <Icon name="download" size={14} />
        <span className="hide-narrow">Export</span>
      </button>
      <button className="btn ghost" onClick={() => fileInput.current?.click()} title="Import a scenario JSON file">
        <Icon name="upload" size={14} />
        <span className="hide-narrow">Import</span>
      </button>
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void importSpec(file);
          e.target.value = '';
        }}
      />
      <button
        className="btn icon ghost"
        onClick={() => lab.setTheme(nextTheme[theme])}
        title={`Theme: ${theme}`}
        aria-label={`Theme: ${theme}`}
      >
        <Icon name={theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'monitor'} />
      </button>
    </header>
  );
}
