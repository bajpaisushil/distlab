import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packagesDir = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Sources of non-determinism that must never appear in simulation code.
 *
 * This is the one rule the whole project rests on: if any of these reaches an
 * engine module, the same seed stops reproducing the same run, and every
 * guarantee built on top of that — replay, architecture comparison, shared bug
 * reports — quietly stops holding.
 */
const FORBIDDEN: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /\bMath\s*\.\s*random\b/, why: 'use Rng, seeded from the scenario' },
  { pattern: /\bDate\s*\.\s*now\b/, why: 'use the simulation clock, not wall-clock time' },
  { pattern: /\bperformance\s*\.\s*now\b/, why: 'use the simulation clock, not wall-clock time' },
  { pattern: /\bnew\s+Date\b/, why: 'use the simulation clock, not wall-clock time' },
  { pattern: /\bsetTimeout\b/, why: 'schedule a simulation event instead of a real timer' },
  { pattern: /\bsetInterval\b/, why: 'schedule a simulation event instead of a real timer' },
  { pattern: /\bcrypto\s*\.\s*randomUUID\b/, why: 'use IdFactory, which counts deterministically' },
];

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === 'node_modules' || entry === 'test') continue;
      sourceFiles(path, found);
    } else if (entry.endsWith('.ts')) {
      found.push(path);
    }
  }
  return found;
}

describe('determinism guard', () => {
  const files = sourceFiles(packagesDir);

  it('finds the engine sources it is meant to be guarding', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.endsWith('simulation.ts'))).toBe(true);
  });

  it.each(FORBIDDEN)('never uses $pattern anywhere in engine code', ({ pattern, why }) => {
    const offenders = files.filter((file) => {
      const source = readFileSync(file, 'utf8');
      // Ignore the rule table in this very test and prose in comments.
      return source.split('\n').some((line) => !line.trimStart().startsWith('*') && pattern.test(line));
    });
    expect(offenders, `${pattern} is banned: ${why}`).toEqual([]);
  });
});
