// Kernel denylist editor behavior and network-backstop obligation.

import { describe, expect, test } from 'bun:test';
import {
  createKernelDenylistPolicy,
  makeKernelDenylistRoutes,
} from '../../extension/background/kernel-denylist-policy.js';

const seed = {
  categories: { sensitive: ['bank.example', '*.health.example'] },
};

const makeKv = (initial: any = null) => {
  const values = new Map<string, any>([['denylist.user.v1', initial]]);
  return {
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: any) => { values.set(key, value); },
    _values: values,
  };
};

const makeKernelLane = ({
  kv = makeKv(), networkCustody = { sync: async () => {} },
}: { kv?: any, networkCustody?: any } = {}) => {
  const audit: any[] = [];
  const policy = createKernelDenylistPolicy({ kv, readSeed: async () => seed });
  const routes = makeKernelDenylistRoutes({
    policy,
    networkCustody,
    auditLog: { append: async (entry: any) => { audit.push(entry); } },
  });
  return { routes, audit, kv, networkCustody };
};

describe('kernel denylist mutation routes', () => {
  test('add and remove preserve normalized overlay state and audit', async () => {
    const kernel = makeKernelLane();
    for (const [route, message] of [
      ['denylist/add', { pattern: ' Private.Example ' }],
      ['denylist/add', { pattern: 'private.example' }],
      ['denylist/remove', { pattern: 'private.example' }],
      ['denylist/remove', { pattern: 'bank.example' }],
      ['denylist/add', { pattern: 'bank.example' }],
      ['denylist/remove', { pattern: 'never-added.example' }],
      ['denylist/add', { pattern: '' }],
    ] as const) {
      await kernel.routes[route](message);
    }
    expect(kernel.kv._values.get('denylist.user.v1')).toEqual({
      added: [], disabled: [],
    });
    expect(kernel.audit.map((entry) => entry.type)).toEqual([
      'denylist_added', 'denylist_added', 'denylist_removed',
      'denylist_removed', 'denylist_added',
    ]);
  });

  test('a successful edit resyncs the network backstop; a refused one does not', async () => {
    const updates: any[] = [];
    const { routes } = makeKernelLane({
      networkCustody: { sync: async () => { updates.push({}); } },
    });
    await routes['denylist/add']({ pattern: 'private.example' });
    expect(updates).toHaveLength(1);
    await routes['denylist/remove']({ pattern: 'missing.example' });
    expect(updates).toHaveLength(1);
    await routes['denylist/remove']({ pattern: 'private.example' });
    expect(updates).toHaveLength(2);
  });

  test('an edit before hydration cannot race the overlay load', async () => {
    const kv = makeKv({ added: ['pre-existing.example'], disabled: [] });
    const { routes } = makeKernelLane({ kv });
    const reply = await routes['denylist/add']({ pattern: 'private.example' });
    expect(reply.added).toEqual(['pre-existing.example', 'private.example']);
  });
});
