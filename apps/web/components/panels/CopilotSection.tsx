'use client';

import { useMemo, useState } from 'react';
import type Anthropic from '@anthropic-ai/sdk';
import {
  ANALYSIS_SCHEMA,
  ANALYSIS_SYSTEM,
  EXPERIMENT_SCHEMA,
  EXPERIMENT_SYSTEM,
  REPAIR_PROMPT,
  SCENARIO_SCHEMA,
  SCENARIO_SYSTEM,
  buildEvidence,
  checkAnalysis,
  checkExperiment,
  checkScenario,
  renderEvidence,
  type CheckedAnalysis,
  type CheckedClaim,
  type CheckedExperiment,
  type CheckedScenario,
  type Explanation,
} from '@distlab/ai';
import { describeChange } from '@distlab/scenarios';
import { useLab } from '@/lib/store';
import { askClaude, COPILOT_MODELS, rememberedKey, rememberKey, type CopilotModel } from '@/lib/copilot';
import { Icon } from '@/components/ui/icons';

type Task = 'analysis' | 'experiment' | 'scenario';

const TASKS: readonly { id: Task; label: string; placeholder: string }[] = [
  { id: 'analysis', label: 'Explain', placeholder: 'Optional: what do you want to understand? e.g. “Why did p99 jump at 4s?”' },
  { id: 'experiment', label: 'Suggest an experiment', placeholder: 'What do you want to test? e.g. “Would a circuit breaker have helped?”' },
  { id: 'scenario', label: 'Draft a scenario', placeholder: 'Describe a system or failure to study, e.g. “a cache stampede when a hot key expires”' },
];

type Result =
  | { kind: 'analysis'; value: CheckedAnalysis }
  | { kind: 'experiment'; value: CheckedExperiment }
  | { kind: 'scenario'; value: CheckedScenario };

const STATUS_TONE: Record<CheckedClaim['status'], string> = {
  grounded: 'status-good',
  interpretation: 'status-warning',
  unverified: 'status-critical',
};

/**
 * Optional AI analysis with the user's own Anthropic key. Off until they send
 * something; they see exactly what will be sent first. Answers are checked
 * against the evidence before they are shown, and proposals only ever reach
 * the simulation through the same validation as anything typed by hand —
 * and only when the user chooses.
 */
export function CopilotSection({ explanation }: { explanation: Explanation | null }) {
  const spec = useLab((s) => s.spec);
  const snapshot = useLab((s) => s.frame?.snapshot);
  const select = useLab((s) => s.select);
  const [open, setOpen] = useState(false);
  const [task, setTask] = useState<Task>('analysis');
  const [question, setQuestion] = useState('');
  const [apiKey, setApiKey] = useState(rememberedKey);
  const [remember, setRemember] = useState(() => rememberedKey() !== '');
  const [model, setModel] = useState<CopilotModel>('claude-opus-5-5');
  const [preview, setPreview] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [usage, setUsage] = useState<string | null>(null);

  const pack = useMemo(
    () => buildEvidence({ spec, snapshot, explanation: explanation ?? undefined, question }),
    [spec, snapshot, explanation, question],
  );
  const outgoing = task === 'scenario' ? question.trim() : renderEvidence(pack);
  const placeholder = TASKS.find((t) => t.id === task)!.placeholder;
  const canSend = apiKey.trim() !== '' && !sending && (task !== 'scenario' || question.trim() !== '');

  const send = async () => {
    setSending(true);
    setError(null);
    setResult(null);
    setUsage(null);
    const base = { apiKey: apiKey.trim(), model };
    const first: Anthropic.Beta.BetaMessageParam = { role: 'user', content: outgoing };
    let tokens = { input: 0, output: 0 };
    try {
      if (task === 'analysis') {
        const reply = await askClaude({ ...base, system: ANALYSIS_SYSTEM, schema: ANALYSIS_SCHEMA, messages: [first], effort: 'medium' });
        if (!reply.ok) return setError(reply.error);
        tokens = reply.usage;
        const checked = checkAnalysis(reply.json, pack);
        return checked.ok ? setResult({ kind: 'analysis', value: checked.value }) : setError(checked.error);
      }
      if (task === 'experiment') {
        const reply = await askClaude({ ...base, system: EXPERIMENT_SYSTEM, schema: EXPERIMENT_SCHEMA, messages: [first], effort: 'medium' });
        if (!reply.ok) return setError(reply.error);
        tokens = reply.usage;
        const checked = checkExperiment(reply.json, spec);
        return checked.ok ? setResult({ kind: 'experiment', value: checked.value }) : setError(checked.error);
      }
      const messages: Anthropic.Beta.BetaMessageParam[] = [first];
      let reply = await askClaude({ ...base, system: SCENARIO_SYSTEM, schema: SCENARIO_SCHEMA, messages, effort: 'high' });
      if (!reply.ok) return setError(reply.error);
      tokens = reply.usage;
      let checked = checkScenario(reply.json);
      // One repair round: the validator's own messages go back, and the answer is checked again.
      if (checked.ok && !checked.value.spec && checked.value.issues.length > 0) {
        messages.push({ role: 'assistant', content: reply.content }, { role: 'user', content: REPAIR_PROMPT(checked.value.issues) });
        reply = await askClaude({ ...base, system: SCENARIO_SYSTEM, schema: SCENARIO_SCHEMA, messages, effort: 'high' });
        if (!reply.ok) return setError(reply.error);
        tokens = { input: tokens.input + reply.usage.input, output: tokens.output + reply.usage.output };
        checked = checkScenario(reply.json);
      }
      return checked.ok ? setResult({ kind: 'scenario', value: checked.value }) : setError(checked.error);
    } finally {
      setSending(false);
      if (tokens.input + tokens.output > 0) setUsage(`${tokens.input.toLocaleString()} input · ${tokens.output.toLocaleString()} output tokens`);
    }
  };

  if (!open) {
    return (
      <div className="callout row" style={{ alignItems: 'center', gap: 10 }}>
        <Icon name="sparkles" size={14} />
        <span style={{ flex: 1 }}>
          <strong>Ask Claude</strong> <span className="muted">— optional. Uses your own Anthropic API key; nothing leaves this browser until you press Send.</span>
        </span>
        <button className="btn" onClick={() => setOpen(true)} data-testid="copilot-open">
          Set up
        </button>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 10, borderTop: '1px solid var(--border)', paddingTop: 12 }} data-testid="copilot">
      <div className="row" style={{ alignItems: 'center' }}>
        <Icon name="sparkles" size={14} />
        <strong style={{ flex: 1 }}>Ask Claude (optional)</strong>
        <button className="btn ghost" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      <div className="field-hint">
        Requests go from this browser straight to api.anthropic.com with your key — DistLab has no server. Claude only reads what is shown in the
        preview; its answer is checked against that evidence before you see it, and it cannot change the simulation.
      </div>

      <div className="grid-2">
        <div className="field">
          <label htmlFor="copilot-key">Anthropic API key</label>
          <input
            id="copilot-key"
            className="input mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-ant-…"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              if (remember) rememberKey(e.target.value || null);
            }}
          />
          <label className="toggle" style={{ marginTop: 4 }}>
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => {
                setRemember(e.target.checked);
                rememberKey(e.target.checked ? apiKey.trim() || null : null);
              }}
            />
            <span>Remember on this device</span>
          </label>
        </div>
        <div className="field">
          <label htmlFor="copilot-model">Model</label>
          <select id="copilot-model" className="select" value={model} onChange={(e) => setModel(e.target.value as CopilotModel)}>
            {COPILOT_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <span className="field-hint">Billed to your key at Anthropic’s rates.</span>
        </div>
      </div>

      <div className="seg" role="tablist" aria-label="What to ask">
        {TASKS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={task === t.id}
            aria-pressed={task === t.id}
            onClick={() => {
              setTask(t.id);
              setResult(null);
              setError(null);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <textarea className="textarea" rows={2} placeholder={placeholder} value={question} onChange={(e) => setQuestion(e.target.value)} />

      <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn" onClick={() => setPreview((p) => !p)}>
          {preview ? 'Hide' : 'Preview'} what will be sent
        </button>
        <span className="spacer" />
        {usage ? <span className="muted mono" style={{ fontSize: 11.5 }}>{usage}</span> : null}
        <button className="btn primary" disabled={!canSend} onClick={send} data-testid="copilot-send">
          {sending ? 'Asking Claude…' : 'Send to Anthropic'}
        </button>
      </div>
      {preview ? (
        <pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 11.5, maxHeight: 240, overflow: 'auto', background: 'var(--surface-2)', padding: 10, borderRadius: 'var(--radius)', margin: 0 }} data-testid="copilot-preview">
          {task === 'scenario'
            ? `${outgoing || '(your description)'}\n\n— plus DistLab’s fixed instructions and scenario format reference. No simulation data is sent for this request.`
            : `${outgoing}\n\n— plus DistLab’s fixed instructions (the grounding rules).`}
        </pre>
      ) : null}

      {error ? <div className="callout status-critical">{error}</div> : null}
      {result?.kind === 'analysis' ? <AnalysisResult value={result.value} onEvent={(id) => select({ kind: 'event', id })} /> : null}
      {result?.kind === 'experiment' ? <ExperimentResult value={result.value} /> : null}
      {result?.kind === 'scenario' ? <ScenarioResult value={result.value} /> : null}
    </div>
  );
}

function AnalysisResult({ value, onEvent }: { value: CheckedAnalysis; onEvent(id: string): void }) {
  const unverified = value.claims.filter((c) => c.status === 'unverified').length;
  return (
    <div className="stack" style={{ gap: 8 }} data-testid="copilot-answer">
      <p className="prose" style={{ margin: 0 }}>
        {value.summary}
      </p>
      {value.summaryProblem ? <div className="muted status-critical">Check this: the summary {value.summaryProblem}.</div> : null}
      <div className="muted" style={{ fontSize: 12 }}>
        Claude’s claims, each checked against the evidence it cites{unverified > 0 ? ` — ${unverified} could not be verified` : ''}:
      </div>
      {value.claims.map((claim, i) => (
        <div key={i} className={`fact ${STATUS_TONE[claim.status]}`} style={{ display: 'grid', gap: 3 }}>
          <span>{claim.text}</span>
          <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <span className="tag">{claim.status === 'grounded' ? `${claim.basis} · checked` : claim.status === 'interpretation' ? 'interpretation' : 'unverified'}</span>
            {claim.cites.map((c) => (
              <span key={c} className="tag mono">
                {c}
              </span>
            ))}
            {claim.eventIds.slice(0, 4).map((id) => (
              <button key={id} className="tag mono" style={{ border: 0, cursor: 'pointer' }} onClick={() => onEvent(id)}>
                {id}
              </button>
            ))}
            {claim.problem ? <span className="status-critical" style={{ fontSize: 12 }}>{claim.problem}</span> : null}
          </span>
        </div>
      ))}
      {value.suggestions.length > 0 ? (
        <div className="stack" style={{ gap: 4 }}>
          <div className="panel-title" style={{ margin: 0 }}>
            Claude suggests trying
          </div>
          {value.suggestions.map((s) => (
            <div key={s} className="row ink-2">
              <Icon name="flask" size={13} /> {s}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ExperimentResult({ value }: { value: CheckedExperiment }) {
  const valid = value.variant !== undefined;
  return (
    <div className="stack" style={{ gap: 8 }} data-testid="copilot-answer">
      <div>
        <strong>{value.experiment.name}</strong>
        {value.experiment.question ? <div className="ink-2">{value.experiment.question}</div> : null}
      </div>
      {value.hypothesis ? (
        <div className="callout">
          <strong>Claude’s prediction</strong> — not a result until you run it: {value.hypothesis}
        </div>
      ) : null}
      {value.experiment.changes.map((change, i) => (
        <div key={i} className="row mono" style={{ fontSize: 12 }}>
          <Icon name="flask" size={13} /> {describeChange(change)}
        </div>
      ))}
      {valid ? (
        <div className="row">
          <span className="muted">Validated against the current scenario.</span>
          <span className="spacer" />
          <button className="btn primary" onClick={() => useLab.getState().proposeExperiment(value.experiment)}>
            Open in What-if
          </button>
        </div>
      ) : (
        <div className="callout status-critical">
          Not runnable as proposed:
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {value.issues.map((issue, i) => (
              <li key={i}>
                <span className="mono">{issue.path}</span>: {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ScenarioResult({ value }: { value: CheckedScenario }) {
  return (
    <div className="stack" style={{ gap: 8 }} data-testid="copilot-answer">
      {value.summary ? <p className="prose" style={{ margin: 0 }}>{value.summary}</p> : null}
      {value.spec ? (
        <div className="row">
          <span className="muted">
            Valid: {value.spec.nodes.length} nodes, {value.spec.links.length} links, {value.spec.workloads.length} workloads, {(value.spec.faults ?? []).length} faults.
          </span>
          <span className="spacer" />
          <button className="btn primary" onClick={() => useLab.getState().loadSpec(value.spec!)}>
            Open in the lab
          </button>
        </div>
      ) : (
        <div className="callout status-critical">
          The scenario did not validate, even after one correction:
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {value.issues.slice(0, 12).map((issue, i) => (
              <li key={i}>
                <span className="mono">{issue.path}</span>: {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
