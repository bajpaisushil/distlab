'use client';

import { useEffect, useState } from 'react';
import { SCENARIOS, type ScenarioCategory } from '@distlab/scenarios';
import type { SimulationSpec } from '@distlab/shared';
import { useLab } from '@/lib/store';
import { deleteDesign, listDesigns, saveDesign, type SavedDesign } from '@/lib/persistence';
import { NODE_LABELS } from '@/lib/spec-edit';
import { Icon, NodeGlyph } from '@/components/ui/icons';
import { useToast } from '@/components/lab/Toast';

const ORDER: readonly ScenarioCategory[] = ['Fundamentals', 'Failures', 'Network', 'Load', 'Data', 'Messaging', 'Coordination'];

export function LibraryView() {
  const spec = useLab((s) => s.spec);
  const lab = useLab.getState();
  const toast = useToast();
  const [designs, setDesigns] = useState<SavedDesign[]>([]);

  useEffect(() => {
    void listDesigns().then(setDesigns);
  }, []);

  const open = (scenario: SimulationSpec) => {
    lab.loadSpec(structuredClone(scenario));
    lab.setView('lab');
  };

  const save = async () => {
    const id = spec.id === 'starter' || SCENARIOS.some((s) => s.spec.id === spec.id) ? `${spec.id}-copy-${designs.length + 1}` : spec.id;
    // Saving is a user action: the wall-clock timestamp only orders the list, it never reaches the engine.
    await saveDesign({ ...spec, id }, Date.now());
    setDesigns(await listDesigns());
    toast(`Saved “${spec.name}” in this browser`);
  };

  return (
    <div className="view-inner" data-testid="library">
      <div className="row" style={{ alignItems: 'end' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20 }}>Scenario library</h1>
          <p className="prose" style={{ margin: '4px 0 0' }}>
            Each scenario is a complete, seeded experiment with something specific to see. Open one, press play, and break
            it further.
          </p>
        </div>
      </div>

      {ORDER.map((category) => {
        const items = SCENARIOS.filter((s) => s.category === category);
        if (items.length === 0) return null;
        return (
          <section key={category} className="stack">
            <h2 className="panel-title" style={{ margin: 0 }}>
              {category}
            </h2>
            <div className="card-grid">
              {items.map(({ spec: scenario, difficulty }) => (
                <button key={scenario.id} className="card scenario-card" onClick={() => open(scenario)} data-testid={`scenario-${scenario.id}`}>
                  <div className="row">
                    <strong style={{ fontSize: 14 }}>{scenario.name}</strong>
                    <span className="spacer" />
                    <span className="tag">{difficulty}</span>
                  </div>
                  <span className="ink-2" style={{ fontSize: 12.5 }}>
                    {scenario.description}
                  </span>
                  <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
                    {[...new Set(scenario.nodes.map((n) => n.type))].map((type) => (
                      <span key={type} className="tag" title={NODE_LABELS[type]}>
                        <NodeGlyph type={type} size={11} />
                        &nbsp;{NODE_LABELS[type]}
                      </span>
                    ))}
                    {(scenario.faults ?? []).length > 0 ? (
                      <span className="tag">
                        <Icon name="bolt" size={11} />
                        &nbsp;{scenario.faults!.length} fault{scenario.faults!.length > 1 ? 's' : ''}
                      </span>
                    ) : null}
                  </div>
                  {scenario.learningObjectives?.[0] ? (
                    <span className="muted" style={{ fontSize: 12 }}>
                      Learn: {scenario.learningObjectives[0]}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </section>
        );
      })}

      <section className="stack">
        <div className="row">
          <h2 className="panel-title" style={{ margin: 0 }}>
            Your designs
          </h2>
          <span className="spacer" />
          <button className="btn" onClick={save}>
            <Icon name="save" size={13} /> Save current design
          </button>
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          Stored in this browser only (IndexedDB). Use Export or Share to move a design elsewhere.
        </div>
        {designs.length === 0 ? <div className="card muted">No saved designs yet.</div> : null}
        <div className="card-grid">
          {designs.map((design) => (
            <div key={design.id} className="card stack" style={{ gap: 6 }}>
              <div className="row">
                <strong>{design.name}</strong>
                <span className="spacer" />
                <button
                  className="btn icon ghost danger"
                  aria-label="Delete design"
                  onClick={async () => {
                    await deleteDesign(design.id);
                    setDesigns(await listDesigns());
                  }}
                >
                  <Icon name="trash" size={13} />
                </button>
              </div>
              <span className="muted" style={{ fontSize: 12 }}>
                {design.spec.nodes.length} nodes · {design.spec.links.length} links · saved {new Date(design.savedAt).toLocaleString()}
              </span>
              <button className="btn" onClick={() => open(design.spec)}>
                Open
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
