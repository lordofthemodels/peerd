#!/usr/bin/env bun
// scripts/cdp/run-eval-bench.mjs — drive the eval/lab task suite over the REAL
// extension and score one BUILD, so we can diff build-over-build instead of
// guessing whether a change helped. Reuse, not a new benchmark tool:
//   - launchPeerd (e2e-harness.mjs) loads the real unpacked extension in
//     headless Chrome for Testing,
//   - this injects a real provider key + selects the model,
//   - opens eval/runner.html and runs the suite through the page's __peerdEval
//     hook (the same runSuite the "Run all tasks" button calls),
//   - writes a commit-tagged scorecard to bench-results/,
//   - and (optionally) runs the PURE score.compare() against a baseline file to
//     surface regressions/fixes — the build-over-build signal.
//
// REAL runs make real model calls and COST MONEY, and need a real key — exactly
// the constraint the owner flagged. The score is tied to YOUR model + key + live
// page state, so a baseline is local + explicit (there's no backend to stash a
// shared one in).
//
// --smoke uses launchPeerd's keyless-Ollama wire fake (no key, no cost, no real
// model) to verify the DRIVER PLUMBING end to end — open → run → read scorecard.
// passRate will be ~0 (the faked model can't solve tasks); that's expected, the
// smoke only asserts a scorecard comes back.
//
// Usage:
//   PEERD_BENCH_KEY=sk-ant-... bun run eval:bench --provider=anthropic --model=claude-haiku-4-5
//   bun run eval:bench --provider=anthropic --model=claude-haiku-4-5 --baseline=scripts/cdp/bench-results/<prev>.json
//   bun run eval:bench --smoke           # zero-cost plumbing check
//
// Flags:
//   --provider=anthropic|openrouter|ollama   (default anthropic; smoke → ollama)
//   --model=<id>                             (default: the provider's default)
//   --suite=simple|robust|web-actor          (default simple; web-actor starts
//                                            a local fixture server + drives it)
//   --actor-surface=tools|code               web actor action surface (default: the
//                                            channel default, i.e. tools). The PR #119
//                                            A/B: run once per surface, diff with
//                                            --baseline. Tagged into the scorecard.
//   --actor-id=<id>                          reproducible ActorRun identity (default peerd-agent)
//   --actor-version=<version>                defaults to the source identity
//   --prompt-version=<version>               defaults to the source identity
//   --task-id=<id>                           run one named task from the selected suite
//   --limit=N                                run only the first N tasks (cost control)
//   --baseline=<path.json>                   diff against a prior scorecard; exit 1 on a regression
//   --guard-tool-errors                      also exit 1 if avg tool errors/task rose vs the baseline
//                                            (opt-in — off by default so an existing bench doesn't
//                                            start failing on the new axis)
//   --budget-min=N                           max minutes to wait for the run (default 45; smoke 5)
//   --show-tabs                              open the agent's eval window visibly
//   --smoke                                  keyless plumbing run (implies provider=ollama, limit=1)
// Key (real mode): PEERD_BENCH_KEY, else ANTHROPIC_API_KEY / OPENROUTER_API_KEY.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPeerd, openExtPage, rpc, evalIn, waitFor, log, PASSPHRASE, sseText } from './e2e-harness.mjs';
import { benchmarkEnvironmentIdentity, sourceIdentity } from './benchmark-identity.mjs';
import { compare } from '../../extension/eval/score.js';
import { buildActorRun, compareActorRuns, validateActorRun } from '../../extension/eval/actor-run.js';
import { SUITES } from '../../extension/eval/tasks.js';
import { startWebFixtureServer } from './fixtures/web-suite.mjs';
import { CATALOG as RED_TEAM_CATALOG } from '../../tests/red-team/index.ts';
import { promptInjectionBenchmark } from '../../tests/red-team/scenarios/08-prompt-injection-benchmark.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const OUT_DIR = resolve(__dirname, 'bench-results');

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};
const valueFlag = (name, def) => {
  const hit = argv.find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (!hit) return def;
  const eq = hit.indexOf('=');
  const value = eq === -1 ? '' : hit.slice(eq + 1);
  if (!value.trim()) {
    console.error(`[bench] --${name} requires a non-empty value`);
    process.exit(2);
  }
  return value;
};

const SMOKE = !!flag('smoke', false);
const PROVIDER = valueFlag('provider', SMOKE ? 'ollama' : 'anthropic');
const MODEL = valueFlag('model', '');
const SUITE = valueFlag('suite', 'simple');
// PR #119 A/B: the web actor's action surface for THIS run. Empty = leave the
// channel default alone ('tools'); 'code' flips the setting before the run.
const ACTOR_SURFACE = valueFlag('actor-surface', '');
if (ACTOR_SURFACE && ACTOR_SURFACE !== 'tools' && ACTOR_SURFACE !== 'code') {
  console.error(`[bench] --actor-surface must be 'tools' or 'code' (got '${ACTOR_SURFACE}')`);
  process.exit(2);
}
const positiveNumberFlag = (name, raw, fallback, { integer = false } = {}) => {
  if (raw === false) return fallback;
  const value = typeof raw === 'string' && raw.trim() ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    console.error(`[bench] --${name} must be a positive ${integer ? 'integer' : 'number'} (got '${String(raw)}')`);
    process.exit(2);
  }
  return value;
};
const LIMIT_FLAG = flag('limit', false);
const REQUESTED_LIMIT = positiveNumberFlag('limit', LIMIT_FLAG, 0, { integer: true });
const LIMIT = SMOKE ? 1 : REQUESTED_LIMIT;
const ACTOR_ID = valueFlag('actor-id', 'peerd-agent');
const ACTOR_VERSION = valueFlag('actor-version', '');
const PROMPT_VERSION = valueFlag('prompt-version', '');
const TASK_ID = valueFlag('task-id', '');
const BASELINE = valueFlag('baseline', '');
const GUARD_TOOL_ERRORS = !!flag('guard-tool-errors', false);
const SHOW_TABS = !!flag('show-tabs', false);
const RUN_BUDGET_MS = positiveNumberFlag('budget-min', flag('budget-min', false), SMOKE ? 5 : 45) * 60_000;

const KEY = process.env.PEERD_BENCH_KEY
  || (PROVIDER === 'anthropic' ? process.env.ANTHROPIC_API_KEY : '')
  || (PROVIDER === 'openrouter' ? process.env.OPENROUTER_API_KEY : '')
  || '';

const isKeyless = (p) => p === 'ollama' || p === 'local-webgpu';
const runtimeVersion = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')).version;
const browserVersion = readFileSync(resolve(__dirname, 'chrome-version.txt'), 'utf8').trim();
const SOURCE_IDENTITY = sourceIdentity(REPO_ROOT);

const usageError = (message) => {
  console.error(`[bench] ${message}`);
  process.exit(2);
};

/** @param {Record<string, any>[]} selectedTasks */
const invocationTasks = (selectedTasks) => {
  if (TASK_ID) return selectedTasks.filter((task) => task.id === TASK_ID);
  if (SMOKE) return [selectedTasks.find((task) => task.id === 'clock-now') ?? selectedTasks[0]];
  return LIMIT ? selectedTasks.slice(0, LIMIT) : selectedTasks;
};

/** @param {Record<string, any>[]} tasks */
const preflightBaseline = (tasks) => {
  if (!BASELINE) return null;
  if (!existsSync(BASELINE)) usageError(`baseline not found: ${BASELINE}`);
  let record;
  try { record = JSON.parse(readFileSync(BASELINE, 'utf8')); }
  catch (error) { usageError(`baseline is not valid JSON: ${/** @type {{ message?: string }} */ (error)?.message ?? error}`); }
  if (!record || typeof record !== 'object' || Array.isArray(record)) usageError('baseline must be a JSON object');
  if (record.suite && record.suite !== SUITE) usageError(`baseline suite ${record.suite} does not match ${SUITE}`);
  const card = record.card ?? record;
  if (!card || typeof card !== 'object' || !Number.isFinite(card.total)
      || !Number.isFinite(card.passRate) || !Array.isArray(card.failures)) {
    usageError('baseline scorecard schema is invalid');
  }
  if (!Array.isArray(record.actorRuns) || record.actorRuns.length === 0) {
    usageError('baseline has no ActorRuns');
  }
  for (const run of record.actorRuns) {
    const validation = validateActorRun(run, { requireEnvironment: true });
    if (!validation.valid) usageError(`baseline ActorRun schema is invalid: ${validation.reasons.join(', ')}`);
  }
  const key = (taskId, taskVersion) => `${taskId}\0${taskVersion}`;
  const expected = new Set(tasks.map((task) => key(task.id, Number.isInteger(task.version) ? task.version : 1)));
  const captured = new Set(record.actorRuns.map((run) => key(run?.metadata?.taskId, run?.metadata?.taskVersion)));
  if (captured.size !== record.actorRuns.length
      || captured.size !== expected.size
      || [...expected].some((taskKey) => !captured.has(taskKey))) {
    usageError('baseline ActorRuns do not match the selected task set');
  }
  return { record, card };
};

/** @param {string} scenarioId */
const runRedTeamScenario = async (scenarioId) => {
  const scenario = RED_TEAM_CATALOG.find((entry) => entry.id === scenarioId);
  if (!scenario) throw new Error(`red-team scenario not found: ${scenarioId}`);
  const result = await scenario.run();
  return {
    source: 'tests/red-team',
    scenarioId: scenario.id,
    threatModelRef: scenario.threatModelRef,
    held: result.held,
    defenses: result.defenses,
    attempted: result.probes.length,
    blocked: result.probes.filter((probe) => probe.blocked).length,
    probes: result.probes,
  };
};

main();

async function main() {
  const selectedTasks = SUITES[SUITE]?.tasks;
  if (!selectedTasks) {
    console.error(`[bench] unknown suite: ${SUITE}`);
    process.exit(2);
  }
  if (TASK_ID && !selectedTasks.some((task) => task.id === TASK_ID)) {
    console.error(`[bench] task ${TASK_ID} is not in suite ${SUITE}`);
    process.exit(2);
  }
  const runTasks = invocationTasks(selectedTasks);
  const baseline = preflightBaseline(runTasks);
  if (!SMOKE && !isKeyless(PROVIDER) && !KEY) {
    console.error('[bench] No provider key. Set PEERD_BENCH_KEY (or ANTHROPIC_API_KEY / OPENROUTER_API_KEY), or run with --smoke for the keyless plumbing check.');
    process.exit(2);
  }
  if (SMOKE) {
    log('SMOKE — keyless Ollama wire fake. No real model calls, no cost. Verifies the driver plumbing only (passRate will be ~0).');
  } else {
    log(`REAL benchmark — provider=${PROVIDER} model=${MODEL || '(provider default)'} suite=${SUITE}${LIMIT ? ` limit=${LIMIT}` : ''}. Makes real API calls and COSTS MONEY.`);
  }
  log(`source: ${SOURCE_IDENTITY.version}`);

  // In smoke mode launchPeerd intercepts the keyless model wire; a fixed no-op
  // answer is fine — we only check the driver yields a scorecard.
  const ctx = await launchPeerd(SMOKE ? { modelResponder: () => ({ sse: sseText('benchmark smoke: no-op answer.') }) } : {});
  // The web-actor suite drives a local fixture site (drift-free); start it on an
  // ephemeral port and thread the base URL into the run (the tasks carry the
  // __FIXTURE__ sentinel). Other suites don't need it.
  let fixture = null;
  try {
    if (runTasks.some((task) => String(task.startUrl ?? '').includes('__FIXTURE__') || String(task.prompt ?? '').includes('__FIXTURE__'))) {
      fixture = await startWebFixtureServer();
      log(`benchmark fixture server → ${fixture.url}`);
    }
    // 1) vault + provider
    const vault = await rpc(ctx.page, { type: 'vault/initialize', passphrase: PASSPHRASE });
    if (!vault?.ok) throw new Error(`vault/initialize failed: ${JSON.stringify(vault)}`);
    await rpc(ctx.page, { type: 'onboarding/complete', peerName: 'peerd', facts: null });

    if (isKeyless(PROVIDER)) {
      const patch = { providerName: PROVIDER };
      if (MODEL) patch.providerModel = MODEL;
      const upd = await rpc(ctx.page, { type: 'settings/update', patch });
      if (!upd?.ok) throw new Error(`settings/update failed: ${JSON.stringify(upd)}`);
    } else {
      const set = await rpc(ctx.page, { type: 'provider/setKey', provider: PROVIDER, plaintext: KEY });
      if (!set?.ok) throw new Error(`provider/setKey failed: ${JSON.stringify(set)}`);
      const patch = { providerName: PROVIDER };
      if (MODEL) patch.providerModel = MODEL;
      const upd = await rpc(ctx.page, { type: 'settings/update', patch });
      if (!upd?.ok) throw new Error(`settings/update failed: ${JSON.stringify(upd)}`);
    }

    const status = await rpc(ctx.page, { type: 'provider/status' });
    const usable = Array.isArray(status?.providers) && status.providers.some((p) => p.name === PROVIDER && p.hasKey);
    if (!usable) throw new Error(`provider ${PROVIDER} is not usable after setup (no key?)`);
    log(`provider ready: ${PROVIDER}${MODEL ? ` (${MODEL})` : ''}`);

    // PR #119 A/B: pin the web actor's action surface for this run. The setting
    // is read live at each actor ctx build, so setting it once up front covers
    // every task. Fail loud if the patch didn't take (a silent fallback would
    // score the WRONG arm and poison the A/B).
    if (ACTOR_SURFACE) {
      const surf = await rpc(ctx.page, { type: 'settings/update', patch: { webActorActionSurface: ACTOR_SURFACE } });
      if (!surf?.ok) throw new Error(`settings/update webActorActionSurface failed: ${JSON.stringify(surf)}`);
      log(`web actor action surface: ${ACTOR_SURFACE}`);
    }

    // 2) open the eval harness page + wait for its driver hook
    const evalPage = await openExtPage(ctx, 'eval/runner.html');
    if (SHOW_TABS) await evalIn(evalPage, `(() => { const c = document.getElementById('showtabs'); if (c) c.checked = true; })()`);
    const ready = await waitFor(() => evalIn(evalPage, `!!(window.__peerdEval && window.__peerdEval.ready)`), { budgetMs: 30_000 });
    if (!ready) throw new Error('eval/runner.html never exposed __peerdEval — is the runner hook present?');

    // 3) start the run (fire-and-forget in the page), then poll — a full suite
    //    outlasts a single awaited CDP call.
    const runOpts = { suite: SUITE };
    if (fixture) runOpts.fixtureBaseUrl = fixture.url;
    // why: clock-now is the cheapest legacy smoke when present; newer suites
    // must still exercise their own first task instead of silently running none.
    if (TASK_ID) runOpts.taskIds = [TASK_ID];
    else if (SMOKE) {
      if (selectedTasks.some((task) => task.id === 'clock-now')) runOpts.taskIds = ['clock-now'];
      else runOpts.limit = 1;
    }
    else if (LIMIT) runOpts.limit = LIMIT;
    await evalIn(evalPage, `(() => { window.__peerdEval.run(${JSON.stringify(runOpts)}); return true; })()`);
    log(`run started (suite=${SUITE}${LIMIT ? `, first ${LIMIT}` : ''}); polling for the scorecard (budget ${Math.round(RUN_BUDGET_MS / 60000)} min)…`);

    const card = await waitFor(async () => {
      const err = await evalIn(evalPage, `window.__peerdEval.lastError`);
      if (err) throw new Error(`eval run failed in-page: ${err}`);
      return evalIn(evalPage, `window.__peerdEval.lastCard`);
    }, { budgetMs: RUN_BUDGET_MS, pollMs: 5_000 });
    if (!card) throw new Error(`run did not finish within ${Math.round(RUN_BUDGET_MS / 60000)} min`);

    const results = await evalIn(evalPage, `window.__peerdEval.lastResults`);

    // Build one reproducible ActorRun per task from the existing session debug
    // bundle. The bundle is the trusted local join over model-relay snapshots,
    // actor sessions, dispatcher/egress audit, cost, and chain verification.
    const tasksById = new Map(selectedTasks.map((task) => [task.id, task]));
    const scenarioIds = [...new Set(results
      .map((result) => tasksById.get(result.id)?.redTeamScenarioId)
      .filter((value) => typeof value === 'string'))];
    const redTeamEvidence = new Map(await Promise.all(scenarioIds.map(async (scenarioId) => [
      scenarioId, await runRedTeamScenario(scenarioId),
    ])));
    const sha = SOURCE_IDENTITY.sha;
    const actorVersion = ACTOR_VERSION || SOURCE_IDENTITY.version;
    const promptVersion = PROMPT_VERSION || SOURCE_IDENTITY.version;
    const actorRuns = [];
    const actorRunErrors = [];
    for (const result of results) {
      const task = tasksById.get(result.id);
      if (!task || !result.sessionId) {
        actorRunErrors.push({ taskId: result.id, error: task ? 'session id unavailable' : 'task metadata unavailable' });
        continue;
      }
      const bundleReply = await rpc(ctx.page, { type: 'session/debugBundle', sessionId: result.sessionId });
      if (!bundleReply?.ok || !bundleReply.bundle) {
        actorRunErrors.push({ taskId: result.id, error: bundleReply?.error ?? 'debug bundle unavailable' });
        continue;
      }
      const scenarioId = task.redTeamScenarioId;
      const runTask = scenarioId === promptInjectionBenchmark.scenarioId
        ? { ...task, securityConstraints: promptInjectionBenchmark.securityConstraints }
        : task;
      actorRuns.push(buildActorRun({
        task: runTask,
        actor: {
          id: ACTOR_ID,
          version: actorVersion,
          promptVersion,
          config: { actorSurface: ACTOR_SURFACE || null, suite: SUITE },
        },
        model: { provider: PROVIDER, id: MODEL || bundleReply.bundle.session?.model || PROVIDER },
        result,
        debugBundle: bundleReply.bundle,
        gitSha: sha,
        runtimeVersion,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        environmentVersion: benchmarkEnvironmentIdentity(REPO_ROOT, runTask, {
          runtimeVersion, browserVersion,
        }),
        environmentOrigins: fixture ? [fixture.url] : [],
        redTeamEvidence: scenarioId ? redTeamEvidence.get(scenarioId) ?? null : null,
        sourceIdentity: SOURCE_IDENTITY,
      }));
    }

    // 4) persist, tagged by commit + model
    mkdirSync(OUT_DIR, { recursive: true });
    const shortSha = SOURCE_IDENTITY.dirty
      ? `${sha.slice(0, 7)}-d${SOURCE_IDENTITY.hash.slice(0, 8)}`
      : sha.slice(0, 7);
    const modelTag = (MODEL || PROVIDER).replace(/[^a-z0-9.-]+/gi, '_');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // The surface rides the filename AND the record so two A/B legs of the same
    // build+model can't be confused when diffing with --baseline.
    const surfaceTag = ACTOR_SURFACE ? `-${ACTOR_SURFACE}` : '';
    const outPath = join(OUT_DIR, `${shortSha}-${modelTag}${surfaceTag}-${stamp}.json`);
    const record = {
      build: sha, runtimeVersion, provider: PROVIDER, model: MODEL || null, suite: SUITE,
      sourceIdentity: SOURCE_IDENTITY,
      actorSurface: ACTOR_SURFACE || null,
      actorId: ACTOR_ID, actorVersion, promptVersion,
      limit: LIMIT || null, smoke: SMOKE, at: new Date().toISOString(),
      card, results, actorRuns, actorRunErrors,
    };
    writeFileSync(outPath, JSON.stringify(record, null, 2));
    log(`scorecard → ${outPath}`);

    // 5) headline + optional baseline diff
    printCard(card);
    if (actorRuns.length) log(`ActorRuns ${actorRuns.length}/${results.length} · AET events ${actorRuns.reduce((sum, run) => sum + run.aet.events.length, 0)} · security violations ${actorRuns.reduce((sum, run) => sum + run.grading.security.violations, 0)}`);
    if (actorRunErrors.length) log(`⚠ ActorRun capture gaps: ${actorRunErrors.map((entry) => `${entry.taskId}: ${entry.error}`).join('; ')}`);
    const ungradableRuns = actorRuns.filter((run) => run.grading.security.gradable !== true);
    if (ungradableRuns.length) {
      log(`⚠ ungradable ActorRuns: ${ungradableRuns.map((run) => `${run.metadata.taskId}: ${run.grading.security.evidenceReasons.join(', ')}`).join('; ')}`);
    }
    const captureFailed = actorRunErrors.length > 0
      || actorRuns.length !== results.length
      || ungradableRuns.length > 0;
    let regressed = false;
    if (baseline) {
      const { record: base, card: baseCard } = baseline;
      const d = compare(baseCard, card);
      printDelta(d);
      regressed = d.regressions.length > 0;
      const actorDeltas = actorRuns.flatMap((run) => {
        const prior = base.actorRuns.find((candidate) => candidate.metadata?.taskId === run.metadata.taskId
          && candidate.metadata?.taskVersion === run.metadata.taskVersion);
        return prior ? [compareActorRuns(prior, run)] : [];
      });
      const currentKeys = new Set(actorRuns.map((run) =>
        `${run.metadata.taskId}\0${run.metadata.taskVersion}`));
      const missingCurrentTasks = base.actorRuns.filter((run) =>
        !currentKeys.has(`${run.metadata?.taskId}\0${run.metadata?.taskVersion}`));
      if (missingCurrentTasks.length) {
        log(`⚠ current capture missing baseline tasks: ${missingCurrentTasks.map((run) => run.metadata?.taskId).join(', ')}`);
        regressed = true;
      }
      const incomparable = actorDeltas.filter((delta) => !delta.comparable);
      for (const delta of incomparable) log(`⚠ incomparable ActorRun: ${delta.reasons.join(', ')}`);
      const actorRegressions = actorDeltas.filter((delta) => delta.comparable
        && (delta.successRegression || delta.securityViolationsDelta > 0 || delta.qualityDelta < 0));
      log(`ActorRun comparisons ${actorDeltas.length} · regressions ${actorRegressions.length}`);
      if (actorRegressions.length || incomparable.length) regressed = true;
      // Opt-in: a change can lift pass-rate while making the agent thrash more.
      // With the guard on, more tool errors/task than the baseline fails the run.
      // Skip when the baseline predates the metric — else its absent avgToolErrors
      // coerces to 0 and EVERY current error reads as a rise (false regression).
      if (GUARD_TOOL_ERRORS && baseCard.avgToolErrors === undefined) {
        log('⚠ baseline has no tool-error metrics — guard skipped; re-baseline to enable it');
      } else if (GUARD_TOOL_ERRORS && d.toolErrorsDelta > 0) {
        log(`⚠ TOOL-ERROR REGRESSION: avg tool errors/task +${d.toolErrorsDelta} (guard on)`);
        regressed = true;
      }
    }

    if (fixture) await fixture.close().catch(() => {});
    ctx.close();
    process.exit(captureFailed || (!SMOKE && regressed) ? 1 : 0);
  } catch (e) {
    console.error('[bench]', e?.message || e);
    if (fixture) await fixture.close().catch(() => {});
    try { ctx.close(); } catch { /* */ }
    process.exit(1);
  }
}

function printCard(card) {
  log('=== SCORECARD ===');
  log(`passRate ${card.passRate}% (${card.passed}/${card.total})  ·  avg ${card.avgSteps} steps  ·  MAIN ${card.avgFreshTokens} fresh + ${card.avgCacheReadTokens} cache  ·  $${card.avgCostUsd}/task  ·  ${(card.avgDurationMs / 1000).toFixed(1)}s`);
  // The ACTOR's spend — where delegated web work (fetch_url bodies, page reads)
  // actually lands. THE number a content-pipeline change moves; the MAIN
  // buckets above barely see it.
  log(`ACTOR ${card.avgRunnerTokens} tok/task ($${card.avgRunnerCostUsd}/task)`);
  // Tool-outcome health (design 5): failed calls + the wasted-turn proxy. These
  // sit BESIDE passRate, never replace it — passRate is the correctness truth.
  if (card.avgToolCalls !== undefined) {
    log(`TOOLS ${card.avgToolErrors} err/task of ${card.avgToolCalls} calls (${(card.toolErrorRate * 100).toFixed(1)}% error rate)  ·  ${card.avgWastedTurns} wasted turns/task`);
    const worst = Object.entries(card.toolErrorsByName ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (worst.length) log(`  top failing tools: ${worst.map(([n, c]) => `${n}×${c}`).join(', ')}`);
  }
  if (card.failures?.length) log(`failures (${card.failures.length}): ${card.failures.map((f) => f.id).join(', ')}`);
}

function printDelta(d) {
  log('=== Δ vs baseline ===');
  const s = (n) => (n >= 0 ? `+${n}` : `${n}`);
  log(`passRate ${s(d.passRateDelta)}%  ·  fresh ${s(d.freshTokensDelta)} tok  ·  ACTOR ${s(d.runnerTokensDelta)} tok  ·  $/task ${s(d.costUsdDelta)}  ·  steps ${s(d.stepsDelta)}`);
  // Negative = the fix reduced errors / wasted work (the win direction).
  log(`tool-errors ${s(d.toolErrorsDelta)}/task  ·  wasted ${s(d.wastedTurnsDelta)}/task`);
  if (d.regressions.length) log(`⚠ REGRESSIONS (${d.regressions.length}): ${d.regressions.join(', ')}`);
  else log(`✓ no regressions${d.fixes.length ? `  ·  fixed: ${d.fixes.join(', ')}` : ''}`);
}
