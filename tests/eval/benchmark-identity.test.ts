import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  benchmarkEnvironmentIdentity, hashSourceState, sourceIdentity,
} from '../../scripts/cdp/benchmark-identity.mjs';

describe('benchmark source identity', () => {
  test('hash covers diff and untracked bytes independent of listing order', () => {
    const base = {
      sha: 'abc', status: Buffer.from('dirty'), diff: Buffer.from('patch'),
      untracked: [
        { path: 'b.js', bytes: Buffer.from('b') },
        { path: 'a.js', bytes: Buffer.from('a') },
      ],
    };
    const hash = hashSourceState(base);
    expect(hash).toBe(hashSourceState({ ...base, untracked: [...base.untracked].reverse() }));
    expect(hash).not.toBe(hashSourceState({ ...base, diff: Buffer.from('other') }));
  });

  test('clean and dirty worktrees have distinct versions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'peerd-benchmark-identity-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      writeFileSync(join(dir, 'actor.js'), 'export const actor = 1;\n');
      execFileSync('git', ['add', 'actor.js'], { cwd: dir });
      execFileSync('git', ['-c', 'user.name=peerd-test', '-c', 'user.email=peerd@example.invalid', 'commit', '-qm', 'base'], { cwd: dir });
      const clean = sourceIdentity(dir);
      expect(clean).toMatchObject({ dirty: false, hash: clean.sha, version: clean.sha });
      writeFileSync(join(dir, 'actor.js'), 'export const actor = 2;\n');
      const dirty = sourceIdentity(dir);
      expect(dirty).toMatchObject({ dirty: true, sha: clean.sha });
      expect(dirty.version).toContain('+dirty.');
      expect(dirty.hash).not.toBe(clean.hash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('environment identity follows its concrete sources and host versions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'peerd-benchmark-environment-'));
    try {
      writeFileSync(join(dir, 'fixture.js'), 'export const fixture = 1;\n');
      mkdirSync(join(dir, 'environment'));
      writeFileSync(join(dir, 'environment', 'dependency.js'), 'export const dependency = 1;\n');
      const task = { environment: { kind: 'browser-fixture', snapshot: 'v1', sources: ['fixture.js', 'environment'] } };
      const host = { runtimeVersion: '0.7.3', browserVersion: '151' };
      const first = benchmarkEnvironmentIdentity(dir, task, host);
      writeFileSync(join(dir, 'fixture.js'), 'export const fixture = 2;\n');
      expect(benchmarkEnvironmentIdentity(dir, task, host)).not.toBe(first);
      writeFileSync(join(dir, 'fixture.js'), 'export const fixture = 1;\n');
      writeFileSync(join(dir, 'environment', 'dependency.js'), 'export const dependency = 2;\n');
      expect(benchmarkEnvironmentIdentity(dir, task, host)).not.toBe(first);
      expect(benchmarkEnvironmentIdentity(dir, task, { ...host, browserVersion: '152' })).not.toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('actor source changes do not mutate a fixture-only environment identity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'peerd-benchmark-environment-axis-'));
    try {
      writeFileSync(join(dir, 'fixture.js'), 'export const fixture = 1;\n');
      writeFileSync(join(dir, 'actor.js'), 'export const actor = 1;\n');
      const task = { environment: { kind: 'browser-fixture', snapshot: 'v1', sources: ['fixture.js'] } };
      const host = { runtimeVersion: '0.7.3', browserVersion: '151' };
      const first = benchmarkEnvironmentIdentity(dir, task, host);
      writeFileSync(join(dir, 'actor.js'), 'export const actor = 2;\n');
      expect(benchmarkEnvironmentIdentity(dir, task, host)).toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
