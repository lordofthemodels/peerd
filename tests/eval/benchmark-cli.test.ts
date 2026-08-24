import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(import.meta.dir, '../../scripts/cdp/run-eval-bench.mjs');

describe('benchmark CLI cost controls', () => {
  test('invalid numeric flags fail before browser launch', () => {
    for (const arg of ['--limit=1x', '--limit', '--limit=0', '--budget-min=nope']) {
      const run = Bun.spawnSync([process.execPath, script, '--smoke', arg], {
        cwd: resolve(import.meta.dir, '../..'),
        env: process.env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(run.exitCode).toBe(2);
      expect(run.stderr.toString()).toContain('must be a positive');
      expect(`${run.stdout.toString()}${run.stderr.toString()}`).not.toContain('Launching');
    }
  });

  test('empty value flags fail before browser launch', () => {
    for (const arg of [
      '--provider=', '--model=', '--suite=', '--actor-surface=', '--actor-id=',
      '--actor-version=', '--prompt-version=', '--task-id=', '--baseline=',
    ]) {
      const run = Bun.spawnSync([process.execPath, script, '--smoke', arg], {
        cwd: resolve(import.meta.dir, '../..'),
        env: process.env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(run.exitCode).toBe(2);
      expect(run.stderr.toString()).toContain('requires a non-empty value');
      expect(`${run.stdout.toString()}${run.stderr.toString()}`).not.toContain('Launching');
    }
  });

  test('missing, malformed, and incompatible baselines fail before browser launch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'peerd-benchmark-baseline-'));
    try {
      const malformed = join(dir, 'malformed.json');
      const incompatible = join(dir, 'incompatible.json');
      const truncated = join(dir, 'truncated.json');
      writeFileSync(malformed, '{');
      writeFileSync(incompatible, JSON.stringify({ total: 1, passRate: 0, failures: [] }));
      writeFileSync(truncated, JSON.stringify({
        suite: 'simple',
        card: { total: 1, passRate: 0, failures: [] },
        actorRuns: [{ metadata: { taskId: 'clock-now', taskVersion: 1 } }],
      }));
      for (const path of [join(dir, 'missing.json'), malformed, incompatible, truncated]) {
        const run = Bun.spawnSync([process.execPath, script, '--smoke', `--baseline=${path}`], {
          cwd: resolve(import.meta.dir, '../..'),
          env: process.env,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(run.exitCode).toBe(2);
        expect(run.stderr.toString()).toContain('baseline');
        expect(`${run.stdout.toString()}${run.stderr.toString()}`).not.toContain('Launching');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
