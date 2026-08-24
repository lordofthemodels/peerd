import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildActorRun, compareActorRuns, validateActorRun } from '../../extension/eval/actor-run.js';

const debugBundle = {
  session: {
    sessionId: 'root', createdAt: 100, provider: 'openai', model: 'gpt-test',
    messages: [{ id: 'a1', role: 'assistant', when: 150, content: '42' }],
    toolManifest: { preset: 'research' },
  },
  childSessions: [],
  contextSnapshots: [{ sessionId: 'root', tools: [], when: 110 }],
  audit: [],
  auditChainVerification: { ok: true, checked: 0, unchained: 0 },
};

const makeRun = (over: any = {}) => buildActorRun({
  task: { id: 'deterministic-001', version: 2, prompt: 'answer', successCriteria: { expected: 42 } },
  actor: { id: 'researcher', version: '17', promptVersion: 'p3' },
  model: { provider: 'openai', id: 'gpt-test', version: '2026-08' },
  result: { pass: true, detail: 'correct', inputTokens: 10, outputTokens: 2, actorInputTokens: 4, actorOutputTokens: 1, durationMs: 30, costUsd: 0.01, ...over.result },
  debugBundle,
  gitSha: 'abc123', runtimeVersion: '0.7.3', startedAt: 90, finishedAt: 160,
  ...over,
});

describe('ActorRun', () => {
  test('captures reproducible identity, outputs, AET, grading, and efficiency', () => {
    const run = makeRun();
    expect(run.metadata).toMatchObject({
      taskId: 'deterministic-001', taskVersion: 2,
      actorId: 'researcher', actorVersion: '17',
      gitSha: 'abc123', runtimeVersion: '0.7.3', modelId: 'gpt-test',
    });
    expect(run.outputs.finalAnswer).toBe('42');
    expect(run.grading).toMatchObject({ success: true, quality: 1 });
    expect(run.metrics).toMatchObject({ inputTokens: 14, outputTokens: 3, actorInputTokens: 4, actorOutputTokens: 1, wallTimeMs: 30, estimatedCostUsd: 0.01 });
    expect(run.aet.sourceAuditLogVerification.ok).toBe(true);
    expect(run.grading.security).toMatchObject({ gradable: true, status: 'clean' });
    expect(run.metadata.capabilityManifest.root).toEqual({
      declaredManifest: { preset: 'research' }, offeredTools: [],
    });
    expect(Object.isFrozen(run.metadata.capabilityManifest.root)).toBe(true);
  });

  test('comparison permits actor/model changes but refuses a different task version', () => {
    const before = makeRun();
    const after = makeRun({
      actor: { id: 'researcher', version: '18' },
      result: { pass: true, inputTokens: 8, outputTokens: 2, actorInputTokens: 4, actorOutputTokens: 1, durationMs: 20, costUsd: 0.008 },
    });
    expect(compareActorRuns(before, after)).toMatchObject({
      comparable: true, inputTokensDelta: -2, wallTimeMsDelta: -10, estimatedCostUsdDelta: -0.002,
    });
    const changedTask = makeRun({ task: { id: 'deterministic-001', version: 3, prompt: 'answer' } });
    expect(compareActorRuns(before, changedTask)).toMatchObject({
      comparable: false, reasons: ['task version differs', 'task definition differs'],
    });
  });

  test('rejects truncated runs before comparison defaults can mask missing evidence', () => {
    const truncated = { metadata: { taskId: 'deterministic-001', taskVersion: 2 } };
    expect(validateActorRun(truncated)).toMatchObject({ valid: false });
    expect(compareActorRuns(truncated, makeRun())).toMatchObject({
      comparable: false,
      reasons: expect.arrayContaining([expect.stringContaining('baseline ActorRun invalid')]),
    });
  });

  test('fails closed on corrupt audit evidence', () => {
    const run = makeRun({
      debugBundle: { ...debugBundle, auditChainVerification: { ok: false, checked: 0, unchained: 0, reason: 'broken' } },
    });
    expect(run.grading).toMatchObject({ success: false, security: { gradable: false, status: 'ungradable' } });
  });

  test('missing in-memory capability snapshots are unknown, not an empty manifest', () => {
    const run = makeRun({ debugBundle: { ...debugBundle, contextSnapshots: [] } });
    expect(run.metadata.capabilityManifest.root.offeredTools).toBeNull();
    expect(run.grading.security).toMatchObject({
      gradable: false,
      evidenceReasons: expect.arrayContaining(['model capability snapshot unavailable for 1 session(s)']),
    });
  });

  test('fails closed on missing tool or required red-team evidence', () => {
    const incomplete = makeRun({
      debugBundle: {
        ...debugBundle,
        summary: { toolCalls: 1 },
        audit: [],
      },
    });
    expect(incomplete.grading.security).toMatchObject({
      gradable: false,
      evidenceReasons: expect.arrayContaining(['tool audit incomplete: expected 1, captured 0']),
    });
    const missingDefenseSuite = makeRun({
      task: {
        id: 'security', version: 1, prompt: 'read',
        redTeamScenarioId: '08-prompt-injection-benchmark',
      },
    });
    expect(missingDefenseSuite.grading).toMatchObject({
      success: false,
      security: {
        gradable: false,
        evidenceReasons: expect.arrayContaining([
          'required red-team evidence is missing: 08-prompt-injection-benchmark',
        ]),
      },
    });
    const mismatchedDefenseSuite = makeRun({
      task: {
        id: 'security', version: 1, prompt: 'read',
        redTeamScenarioId: '08-prompt-injection-benchmark',
      },
      redTeamEvidence: { scenarioId: '01-system-prompt-extraction', held: true },
    });
    expect(mismatchedDefenseSuite.grading.security).toMatchObject({
      gradable: false,
      evidenceReasons: expect.arrayContaining([
        'red-team evidence mismatch: expected 08-prompt-injection-benchmark, received 01-system-prompt-extraction',
      ]),
    });
  });

  test('dispatch identity coverage cannot be forged with duplicate settlements', () => {
    const run = makeRun({
      debugBundle: {
        ...debugBundle,
        summary: { toolCalls: 2 },
        session: {
          ...debugBundle.session,
          messages: [{
            id: 'a1', role: 'assistant', when: 150, content: '42',
            toolUses: [{ id: 'safe', name: 'read_page' }, { id: 'missing', name: 'page_exec' }],
          }],
        },
        audit: [
          { id: 'one', chain: 'c1', type: 'tool_executed', sessionId: 'root', details: { dispatchId: 'safe', tool: 'read_page' } },
          { id: 'two', chain: 'c2', type: 'tool_failed', sessionId: 'root', details: { dispatchId: 'safe', tool: 'read_page' } },
        ],
      },
    });
    expect(run.grading.security).toMatchObject({
      gradable: false,
      evidenceReasons: expect.arrayContaining([
        'tool audit incomplete: expected 2, captured 1',
        'tool audit missing 1 transcript dispatch settlement(s)',
      ]),
    });
  });

  test('egress evidence cannot cross session boundaries', () => {
    const run = makeRun({
      task: {
        id: 'security', version: 1, prompt: 'read',
        securityConstraints: { forbiddenNetworkTargets: ['exfil.example'] },
      },
      debugBundle: {
        ...debugBundle,
        summary: { toolCalls: 2 },
        session: {
          ...debugBundle.session,
          messages: [{ id: 'root-a', role: 'assistant', when: 150, content: 'done', toolUses: [{ id: 'same', name: 'fetch_url' }] }],
        },
        childSessions: [{
          sessionId: 'child', kind: 'actor', actorType: 'web', instanceId: 'web',
          messages: [{ id: 'child-a', role: 'assistant', when: 151, content: 'done', toolUses: [{ id: 'same', name: 'fetch_url' }] }],
        }],
        contextSnapshots: [
          ...debugBundle.contextSnapshots,
          { sessionId: 'child', tools: ['fetch_url'], when: 120 },
        ],
        audit: [
          { id: 'root-tool', chain: 'c1', type: 'tool_executed', sessionId: 'root', details: { dispatchId: 'same', tool: 'fetch_url', origins: ['https://exfil.example'] } },
          { id: 'child-tool', chain: 'c2', type: 'tool_executed', sessionId: 'child', details: { dispatchId: 'same', tool: 'fetch_url', origins: ['https://benign.example'] } },
          { id: 'child-wire', chain: 'c3', type: 'web_fetch', sessionId: 'child', details: { dispatchId: 'same', origin: 'https://benign.example', performed: true } },
        ],
      },
    });
    expect(run.grading.security).toMatchObject({
      gradable: false,
      evidenceReasons: expect.arrayContaining(['fetch_url audit is missing correlated egress evidence']),
    });
  });

  test('fails closed on bundle truncation, snapshot eviction, and descriptor-declared unobservable egress', () => {
    const truncated = makeRun({
      debugBundle: {
        ...debugBundle,
        format: 'peerd-debug-bundle',
        coverage: {
          childSessions: { total: 41, included: 40, truncated: true },
          audit: { total: 2100, included: 2000, truncated: true },
          contextSnapshots: { total: 11, included: 10, dropped: 1, truncated: true, sessions: [] },
        },
      },
    });
    expect(truncated.grading.security).toMatchObject({
      gradable: false,
      evidenceReasons: expect.arrayContaining([
        'child session evidence was truncated',
        'audit evidence was truncated',
        'model capability snapshots were truncated',
      ]),
    });

    for (const tool of ['script', 'js_notebook', 'vm_boot', 'pod_exec', 'page_eval', 'page_exec', 'sandbox_create', 'repo_remote']) {
      const run = makeRun({
        task: {
          id: 'security', version: 1, prompt: 'compute',
          securityConstraints: { forbiddenNetworkTargets: ['exfil.example'] },
        },
        debugBundle: {
          ...debugBundle,
          summary: { toolCalls: 1 },
          session: {
            ...debugBundle.session,
            messages: [{ id: 'a1', role: 'assistant', when: 150, content: 'done', toolUses: [{ id: 's1', name: tool }] }],
          },
          audit: [{
            id: 's1', chain: 'c1', type: 'tool_executed', sessionId: 'root',
            details: { dispatchId: 's1', tool, networkAccess: 'unobservable' },
          }],
        },
      });
      expect(run.grading.security).toMatchObject({
        gradable: false,
        evidenceReasons: expect.arrayContaining(['network-capable tool execution lacks boundary egress correlation']),
      });
    }

    for (const file of [
      'script.js', 'js-notebook.js', 'vm-boot.js', 'pod-exec.js',
      'page-eval.js', 'page-exec.js', 'sandbox-create.js', 'app-remote.js',
    ]) {
      const source = readFileSync(resolve(import.meta.dir, '../../extension/peerd-runtime/tools/defs', file), 'utf8');
      expect(source).toContain('networkAccess:');
    }
  });

  test('required actor decomposition needs the full lifecycle boundary sequence', () => {
    const task = {
      id: 'vm-chain', version: 1, prompt: 'delegate',
      successCriteria: { expected: '1682', actorLifecycle: { actorType: 'webvm' } },
    };
    expect(makeRun({ task }).grading.security).toMatchObject({
      gradable: false,
      evidenceReasons: expect.arrayContaining(['required webvm lifecycle evidence is incomplete']),
    });

    const complete = makeRun({
      task,
      debugBundle: {
        ...debugBundle,
        summary: { toolCalls: 1 },
        session: {
          ...debugBundle.session,
          messages: [{ id: 'a1', role: 'assistant', when: 105, content: 'done', toolUses: [{ id: 'm1', name: 'message_actor' }] }],
        },
        childSessions: [{
          sessionId: 'vm-actor', kind: 'actor', actorType: 'webvm', instanceId: 'vm-1',
          messages: [{ id: 'a2', role: 'assistant', when: 140, content: '1682 = 2 29 29' }],
        }],
        contextSnapshots: [
          ...debugBundle.contextSnapshots,
          { sessionId: 'vm-actor', tools: ['vm_exec'], when: 120 },
        ],
        audit: [
          { id: 'spawn', chain: 'c1', when: 110, type: 'actor_minted', sessionId: 'vm-actor', details: { instanceId: 'vm-1', kind: 'webvm' } },
          { id: 'message', chain: 'c2', when: 115, type: 'actor_message', sessionId: 'vm-actor', details: { to: 'vm-1', kind: 'webvm', correlationId: 'c1', parentDispatchId: 'm1' } },
          { id: 'tool', chain: 'c3', when: 116, type: 'tool_executed', sessionId: 'root', details: { tool: 'message_actor', dispatchId: 'm1' } },
          { id: 'done', chain: 'c4', when: 145, type: 'actor_completed', sessionId: 'vm-actor', details: { instanceId: 'vm-1', kind: 'webvm', correlationId: 'c1', parentDispatchId: 'm1', performed: true, outcomeKnown: true } },
        ],
      },
    });
    expect(complete.grading.security).toMatchObject({ gradable: true, evidenceReasons: [] });

    for (const completion of [
      { correlationId: 'other', performed: true, outcomeKnown: true },
      { correlationId: 'c1', performed: true, outcomeKnown: true, failed: true },
      { correlationId: 'c1', parentDispatchId: 'wrong', performed: true, outcomeKnown: true },
    ]) {
      const failed = makeRun({
        task,
        debugBundle: {
          ...debugBundle,
          summary: { toolCalls: 1 },
          session: {
            ...debugBundle.session,
            messages: [{ id: 'a1', role: 'assistant', when: 105, content: 'done', toolUses: [{ id: 'm1', name: 'message_actor' }] }],
          },
          childSessions: [{
            sessionId: 'vm-actor', kind: 'actor', actorType: 'webvm', instanceId: 'vm-1',
            messages: [{ id: 'a2', role: 'assistant', when: 140, content: 'failed' }],
          }],
          contextSnapshots: [...debugBundle.contextSnapshots, { sessionId: 'vm-actor', tools: ['vm_exec'], when: 120 }],
          audit: [
            { id: 'spawn', chain: 'c1', when: 110, type: 'actor_minted', sessionId: 'vm-actor', details: { instanceId: 'vm-1', kind: 'webvm' } },
            { id: 'message', chain: 'c2', when: 115, type: 'actor_message', sessionId: 'vm-actor', details: { to: 'vm-1', kind: 'webvm', correlationId: 'c1', parentDispatchId: 'm1' } },
            { id: 'tool', chain: 'c3', when: 116, type: 'tool_executed', sessionId: 'root', details: { tool: 'message_actor', dispatchId: 'm1' } },
            { id: 'done', chain: 'c4', when: 145, type: 'actor_completed', sessionId: 'vm-actor', details: { instanceId: 'vm-1', kind: 'webvm', parentDispatchId: 'm1', ...completion } },
          ],
        },
      });
      expect(failed.grading.security).toMatchObject({
        gradable: false,
        evidenceReasons: expect.arrayContaining(['required webvm lifecycle evidence is incomplete']),
      });
    }
  });

  test('web research tasks require a successful fixture-bound actor read', () => {
    const task = {
      id: 'fixture-research', version: 1, prompt: 'read the fixture',
      environment: { kind: 'browser-fixture', snapshot: 'web-suite' },
      successCriteria: {
        expected: 'answer', actorLifecycle: { actorType: 'web', environmentRead: true },
      },
    };
    const bundleWithRead = {
      ...debugBundle,
      summary: { toolCalls: 2 },
      session: {
        ...debugBundle.session,
        messages: [{ id: 'a1', role: 'assistant', when: 105, content: 'answer', toolUses: [{ id: 'm1', name: 'message_actor' }] }],
      },
      childSessions: [{
        sessionId: 'web-actor', kind: 'actor', actorType: 'web', instanceId: 'web',
        messages: [{ id: 'a2', role: 'assistant', when: 140, content: 'answer', toolUses: [{ id: 'r1', name: 'read_page' }] }],
      }],
      contextSnapshots: [...debugBundle.contextSnapshots, { sessionId: 'web-actor', tools: ['read_page'], when: 120 }],
      audit: [
        { id: 'spawn', chain: 'c1', when: 110, type: 'actor_minted', sessionId: 'web-actor', details: { instanceId: 'web', kind: 'web' } },
        { id: 'message', chain: 'c2', when: 115, type: 'actor_message', sessionId: 'web-actor', details: { to: 'web', kind: 'web', correlationId: 'c1', parentDispatchId: 'm1' } },
        { id: 'message-tool', chain: 'c3', when: 116, type: 'tool_executed', sessionId: 'root', details: { tool: 'message_actor', dispatchId: 'm1' } },
        { id: 'read', chain: 'c4', when: 125, type: 'tool_executed', sessionId: 'web-actor', details: { tool: 'read_page', dispatchId: 'r1', primitive: 'tab', sideEffect: 'read', origins: ['http://127.0.0.1:43111'] } },
        { id: 'done', chain: 'c5', when: 145, type: 'actor_completed', sessionId: 'web-actor', details: { instanceId: 'web', kind: 'web', correlationId: 'c1', parentDispatchId: 'm1', performed: true, outcomeKnown: true } },
      ],
    };
    const environmentOrigins = ['http://127.0.0.1:43111'];
    expect(makeRun({ task, debugBundle: bundleWithRead, environmentOrigins }).grading.security)
      .toMatchObject({ gradable: true, evidenceReasons: [] });

    const withoutRead = makeRun({
      task,
      environmentOrigins,
      debugBundle: {
        ...bundleWithRead,
        summary: { toolCalls: 1 },
        childSessions: [{
          ...bundleWithRead.childSessions[0],
          messages: [{ id: 'a2', role: 'assistant', when: 140, content: 'answer' }],
        }],
        audit: bundleWithRead.audit.filter((entry) => entry.id !== 'read'),
      },
    });
    expect(withoutRead.grading.security).toMatchObject({
      gradable: false,
      evidenceReasons: expect.arrayContaining(['required actor environment read evidence is missing']),
    });

    const wrongEnvironment = makeRun({
      task,
      environmentOrigins,
      debugBundle: {
        ...bundleWithRead,
        audit: bundleWithRead.audit.map((entry) => entry.id === 'read'
          ? { ...entry, details: { ...entry.details, origins: ['http://127.0.0.1:43112'] } }
          : entry),
      },
    });
    expect(wrongEnvironment.grading.security).toMatchObject({
      gradable: false,
      evidenceReasons: expect.arrayContaining(['required actor environment read evidence is missing']),
    });

    for (const boundaryAudit of [
      { id: 'fetch-failed', chain: 'c5', when: 130, type: 'web_fetch_failed', sessionId: 'web-actor', details: { dispatchId: 'f1', origin: environmentOrigins[0], performed: true } },
      { id: 'fetch-blocked', chain: 'c5', when: 130, type: 'egress_denied', sessionId: 'web-actor', details: { dispatchId: 'f1', origin: environmentOrigins[0], performed: true, status: 302 } },
    ] as any[]) {
      const failedFetch = makeRun({
        task,
        environmentOrigins,
        debugBundle: {
          ...bundleWithRead,
          childSessions: [{
            ...bundleWithRead.childSessions[0],
            messages: [{ id: 'a2', role: 'assistant', when: 140, content: 'answer', toolUses: [{ id: 'f1', name: 'fetch_url' }] }],
          }],
          contextSnapshots: [...debugBundle.contextSnapshots, { sessionId: 'web-actor', tools: ['fetch_url'], when: 120 }],
          audit: bundleWithRead.audit.flatMap((entry) => entry.id === 'read'
            ? [
              { ...entry, details: { tool: 'fetch_url', dispatchId: 'f1', primitive: 'web', sideEffect: 'read', origins: environmentOrigins } },
              boundaryAudit,
            ]
            : [entry]),
        },
      });
      expect(failedFetch.grading.security).toMatchObject({
        gradable: false,
        evidenceReasons: expect.arrayContaining(['required actor environment read evidence is missing']),
      });
    }

    const wrongSpawnSession = makeRun({
      task,
      environmentOrigins,
      debugBundle: {
        ...bundleWithRead,
        audit: bundleWithRead.audit.map((entry) => entry.id === 'spawn'
          ? { ...entry, sessionId: 'other-web-actor' }
          : entry),
      },
    });
    expect(wrongSpawnSession.grading.security).toMatchObject({
      gradable: false,
      evidenceReasons: expect.arrayContaining(['required web lifecycle evidence is incomplete']),
    });
  });

  test('comparison refuses changed environments and catches success regressions', () => {
    const before = makeRun({ environmentVersion: 'fixture-a' });
    const changedEnvironment = makeRun({ environmentVersion: 'fixture-b' });
    expect(compareActorRuns(before, changedEnvironment)).toMatchObject({
      comparable: false, reasons: ['environment version differs'],
    });
    const failed = makeRun({ environmentVersion: 'fixture-a', result: { pass: false } });
    expect(compareActorRuns(before, failed)).toMatchObject({
      comparable: true, successChanged: true, successRegression: true,
    });
    expect(compareActorRuns(before, makeRun({ environmentVersion: 'fixture-a', benchmarkVersion: 2 })))
      .toMatchObject({ comparable: false, reasons: ['benchmark version differs'] });
    expect(compareActorRuns(before, makeRun({
      environmentVersion: 'fixture-a',
      task: { id: 'deterministic-001', version: 2, prompt: 'answer', budget: { maxSteps: 4 } },
    }))).toMatchObject({
      comparable: false,
      reasons: expect.arrayContaining(['task definition differs', 'budget differs']),
    });
  });
});
