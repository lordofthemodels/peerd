// @ts-check
// Reproducible source identity for benchmark runs.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';

/**
 * @param {{ sha: string, status: Buffer, diff: Buffer,
 *   untracked: Array<{ path: string, bytes: Buffer }> }} state
 */
export const hashSourceState = ({ sha, status, diff, untracked }) => {
  const hash = createHash('sha256');
  hash.update(`sha\0${sha}\0status\0`);
  hash.update(status);
  hash.update('\0diff\0');
  hash.update(diff);
  for (const file of [...untracked].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`\0untracked\0${file.path}\0`);
    hash.update(file.bytes);
  }
  return hash.digest('hex');
};

/** @param {string} cwd */
export const sourceIdentity = (cwd) => {
  const run = (/** @type {string[]} */ args) => execFileSync('git', args, { cwd, encoding: 'buffer' });
  const sha = run(['rev-parse', 'HEAD']).toString().trim();
  const status = run(['status', '--porcelain=v1', '--untracked-files=all']);
  const dirty = status.length > 0;
  if (!dirty) return Object.freeze({ sha, dirty: false, hash: sha, version: sha });
  const diff = run(['diff', '--binary', 'HEAD']);
  const untrackedPaths = run(['ls-files', '--others', '--exclude-standard', '-z'])
    .toString().split('\0').filter(Boolean);
  const hash = hashSourceState({
    sha, status, diff,
    untracked: untrackedPaths.map((path) => ({ path, bytes: readFileSync(`${cwd}/${path}`) })),
  });
  return Object.freeze({ sha, dirty: true, hash, version: `${sha}+dirty.${hash.slice(0, 12)}` });
};

/**
 * Hash the concrete world/fixture inputs and host/runtime versions that define
 * a benchmark task's environment. System-under-test source belongs to actor
 * and source identity so changing actor code remains a valid comparison axis.
 * @param {string} cwd
 * @param {Record<string, any>} task
 * @param {{ runtimeVersion: string, browserVersion: string }} host
 */
export const benchmarkEnvironmentIdentity = (cwd, task, host) => {
  const environment = task?.environment ?? {};
  const sources = Array.isArray(environment.sources)
    ? environment.sources.filter((/** @type {unknown} */ path) => typeof path === 'string').sort()
    : [];
  const hash = createHash('sha256');
  hash.update(JSON.stringify({
    kind: environment.kind ?? 'peerd-live',
    snapshot: environment.snapshot ?? null,
    runtimeVersion: host.runtimeVersion,
    browserVersion: host.browserVersion,
  }));
  /** @type {string[]} */
  const files = [];
  /** @param {string} path */
  const collect = (path) => {
    const absolute = join(cwd, path);
    if (statSync(absolute).isDirectory()) {
      for (const entry of readdirSync(absolute, { withFileTypes: true })) {
        collect(join(path, entry.name));
      }
      return;
    }
    files.push(relative(cwd, absolute));
  };
  for (const source of sources) collect(source);
  for (const path of files.sort()) {
    hash.update(`\0${path}\0`);
    hash.update(readFileSync(join(cwd, path)));
  }
  return `${environment.kind ?? 'peerd-live'}:${hash.digest('hex').slice(0, 20)}`;
};
