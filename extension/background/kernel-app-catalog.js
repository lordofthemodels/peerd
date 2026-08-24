// @ts-check
// Native App metadata authority; bytes and repository work stay demand-owned.

import { parseAppManifest } from '/peerd-engine/app-manifest.js';
import { makeSerialLane } from '../shared/cold-util.js';

export const KERNEL_APP_CATALOG_KEY = 'apps.v1';

const INSTRUCTION_PREVIEW_MAX = 480;
const CONTROL_OR_BIDI = /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;
const DEFAULT_APP_AGENT = Object.freeze({
  kind: 'bound-app', profile: 'developer', surface: 'code',
});

/** @param {unknown} value */
const normalizedDisplayText = (value) => typeof value === 'string'
  ? value.replace(CONTROL_OR_BIDI, ' ').replace(/\s+/g, ' ').trim() : '';

/** @param {unknown} value @param {string} fallback @param {number} max */
const displayText = (value, fallback, max) =>
  (normalizedDisplayText(value) || fallback).slice(0, max);

/** @param {unknown} value */
const instructionPreview = (value) => {
  const valueText = normalizedDisplayText(value);
  if (!valueText) return null;
  return valueText.length > INSTRUCTION_PREVIEW_MAX
    ? `${valueText.slice(0, INSTRUCTION_PREVIEW_MAX - 1)}…` : valueText;
};

/**
 * Human-facing projection only. Authority continues to use app-actor-policy.js.
 * @param {any} app
 * @param {any|null} contract
 * @param {'declared'|'default'|'invalid'|'unavailable'} manifest
 */
export const kernelAppActorMetadata = (app, contract, manifest = 'declared') => {
  const agent = contract?.agent ?? DEFAULT_APP_AGENT;
  const publisher = typeof app?.dweb?.publisher === 'string'
    ? app.dweb.publisher.trim() : '';
  const provenance = publisher
    ? { source: app?.source === 'dweb' ? 'dweb' : 'local', publisher }
    : app?.source === 'imported'
      ? { source: 'unsigned-import', publisher: 'unsigned import' }
      : { source: 'local', publisher: 'local user' };
  const appName = displayText(app?.name, 'App', 80);
  const versionId = typeof app?.dweb?.version_id === 'string'
    ? app.dweb.version_id : null;
  return Object.freeze({
    id: `app:${app.id}`,
    handle: app.id,
    appName,
    name: displayText(agent.name, `${appName.slice(0, 74)} actor`, 80),
    kind: 'app',
    model: 'owner-chat',
    profile: agent.profile ?? 'developer',
    surface: agent.surface ?? 'code',
    runtime: Object.freeze(Array.isArray(agent.runtime) ? [...agent.runtime] : []),
    capabilities: Object.freeze(Array.isArray(contract?.capabilities)
      ? contract.capabilities.map((/** @type {unknown} */ value) =>
          displayText(value, '', 64)).filter(Boolean)
      : []),
    instructions: Object.freeze({
      custom: typeof agent.instructions === 'string' && !!agent.instructions.trim(),
      preview: instructionPreview(agent.instructions),
    }),
    manifest,
    provenance: Object.freeze({
      source: provenance.source,
      publisher: displayText(provenance.publisher, 'unknown', 160),
    }),
    version: versionId
      ? Object.freeze({
          kind: 'published', id: displayText(versionId, '', 160),
          sequence: Number.isSafeInteger(app?.dweb?.seq) && app.dweb.seq >= 0
            ? app.dweb.seq : null,
        })
      : Object.freeze({
          kind: 'working-copy', id: null,
          updatedAt: typeof app?.updatedAt === 'number' ? app.updatedAt : null,
        }),
    security: Object.freeze({
      boundary: 'dedicated-keyless-worker',
      authority: 'host-profile-intersect-owner',
    }),
  });
};

/** @param {any} app @param {any} appFiles */
const describeAppActor = async (app, appFiles) => {
  if (typeof appFiles?.readText !== 'function') {
    return kernelAppActorMetadata(app, null, 'default');
  }
  try {
    if (typeof appFiles.listApp === 'function') {
      const paths = await appFiles.listApp(app.id);
      if (!Array.isArray(paths)) return kernelAppActorMetadata(app, null, 'unavailable');
      const hasManifest = paths.some((/** @type {unknown} */ path) =>
        typeof path === 'string' && path.replace(/^\/+/, '') === 'peerd.json');
      // why list before read: the repository transport intentionally bounds
      // errors, so a missing file loses its NotFoundError name in transit.
      if (!hasManifest) return kernelAppActorMetadata(app, null, 'default');
    }
    const contract = parseAppManifest(await appFiles.readText(app.id, 'peerd.json'));
    return kernelAppActorMetadata(app, contract, 'declared');
  } catch (cause) {
    if (/** @type {{name?:unknown}} */ (cause)?.name === 'NotFoundError') {
      return kernelAppActorMetadata(app, null, 'default');
    }
    const message = typeof /** @type {{message?:unknown}} */ (cause)?.message === 'string'
      ? /** @type {{message:string}} */ (cause).message : '';
    const invalid = message.startsWith('peerd.json ') || message.startsWith('a dwapp manifest ');
    // why unavailable is separate: a transient filesystem fault is not evidence
    // that a package declaration is malformed, and the Hub must not say it is.
    return kernelAppActorMetadata(app, null, invalid ? 'invalid' : 'unavailable');
  }
};

/** @param {unknown} cause @param {string} code @param {string} action */
const catalogEffectFailure = (cause, code, action) => {
  void cause;
  return {
    ok: false,
    error: `Peerd could not confirm whether ${action} finished. Refresh to reconcile before trying again.`,
    code,
    outcomeKnown: false,
    outcomeKind: 'unknown',
    retryable: false,
  };
};

/** @typedef {{schemaVersion:1,apps:Record<string,any>,sessionDefaults:Record<string,string>}} KernelAppCatalogState */

/** @param {unknown} row @returns {KernelAppCatalogState|null} */
export const parseKernelAppCatalogRow = (row) => {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const envelope = /** @type {{key?:unknown,value?:unknown}} */ (row);
  if (envelope.key !== KERNEL_APP_CATALOG_KEY || !envelope.value
      || typeof envelope.value !== 'object' || Array.isArray(envelope.value)) return null;
  const state = /** @type {Record<string,any>} */ (envelope.value);
  if (state.schemaVersion !== 1 || !state.apps
      || typeof state.apps !== 'object' || Array.isArray(state.apps)
      || (state.sessionDefaults !== undefined
        && (typeof state.sessionDefaults !== 'object'
          || state.sessionDefaults === null || Array.isArray(state.sessionDefaults)))) return null;
  if (state.sessionDefaults === undefined) return /** @type {KernelAppCatalogState} */ ({
    ...state, sessionDefaults: {},
  });
  return /** @type {KernelAppCatalogState} */ (state);
};

/** @param {unknown} row */
export const kernelAppCatalogRows = (row) => {
  const state = parseKernelAppCatalogRow(row);
  return state ? Object.values(state.apps) : [];
};

/** @param {unknown} row @param {string} sessionId */
export const kernelSessionAppId = (row, sessionId) => {
  const state = parseKernelAppCatalogRow(row);
  if (!state) return null;
  const appId = state.sessionDefaults[sessionId];
  return typeof appId === 'string' && Object.hasOwn(state.apps, appId) ? appId : null;
};

/** @param {any} deps */
export const createKernelAppCatalog = ({
  idb, now = Date.now,
  newId = () => `app-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
}) => {
  if (typeof idb?.get !== 'function' || typeof idb?.put !== 'function') {
    throw new TypeError('kernel-app-catalog-idb-invalid');
  }
  const read = () => idb.get('apps', KERNEL_APP_CATALOG_KEY);
  const mutate = makeSerialLane();
  /** @type {Record<string,any>|null} */
  let liveRegistry = null;
  const run = (/** @type {()=>Promise<any>} */ cold,
    /** @type {(registry:Record<string,any>)=>Promise<any>} */ live) =>
    mutate(() => liveRegistry ? live(liveRegistry) : cold());
  /** @param {string} appId @param {Record<string,unknown>} patch */
  const patchApp = (appId, patch) => run(async () => {
    const state = parseKernelAppCatalogRow(await read());
    const current = state?.apps[appId];
    if (!state || !current) return null;
    state.apps[appId] = { ...current, ...patch, updatedAt: now() };
    await idb.put('apps', { key: KERNEL_APP_CATALOG_KEY, value: state });
    return state.apps[appId];
  }, (registry) => registry.update(appId, patch));
  const boundRegistry = Object.freeze({
    load: () => run(async () => {}, (registry) => registry.load()),
    list: () => run(async () => kernelAppCatalogRows(await read()), (registry) => registry.list()),
    get: (/** @type {string} */ id) => run(
      async () => parseKernelAppCatalogRow(await read())?.apps[id] ?? null,
      (registry) => registry.get(id),
    ),
    create: (/** @type {any} */ input) => run(
      async () => { throw new Error('kernel-app-registry-not-bound'); },
      (registry) => registry.create(input),
    ),
    update: (/** @type {string} */ id, /** @type {any} */ patch) => run(
      async () => { throw new Error('kernel-app-registry-not-bound'); },
      (registry) => registry.update(id, patch),
    ),
    delete: (/** @type {string} */ id) => run(
      async () => { throw new Error('kernel-app-registry-not-bound'); },
      (registry) => registry.delete(id),
    ),
    getDefaultForSession: (/** @type {string} */ sessionId) => run(
      async () => kernelSessionAppId(await read(), sessionId),
      (registry) => registry.getDefaultForSession(sessionId),
    ),
    setDefaultForSession: (/** @type {string} */ sessionId, /** @type {string} */ id) => run(
      async () => { throw new Error('kernel-app-registry-not-bound'); },
      (registry) => registry.setDefaultForSession(sessionId, id),
    ),
    setActorSession: (/** @type {string} */ id, /** @type {string} */ actorSessionId) => run(
      async () => { throw new Error('kernel-app-registry-not-bound'); },
      (registry) => registry.setActorSession(id, actorSessionId),
    ),
    getActorSession: (/** @type {string} */ id) => run(
      async () => null,
      (registry) => registry.getActorSession(id),
    ),
    snapshot: (/** @type {any} */ options = {}) => run(
      async () => ({ apps: kernelAppCatalogRows(await read()), currentId: null }),
      (registry) => registry.snapshot(options),
    ),
    searchMetadata: (/** @type {string} */ query) => run(
      async () => [],
      (registry) => registry.searchMetadata(query),
    ),
  });
  return Object.freeze({
    bindLiveRegistry: (/** @type {()=>Promise<Record<string,any>>} */ create) => mutate(async () => {
      if (liveRegistry) return boundRegistry;
      const registry = await create();
      if (!registry || typeof registry.load !== 'function') {
        throw new TypeError('kernel-app-live-registry-invalid');
      }
      await registry.load();
      liveRegistry = registry;
      return boundRegistry;
    }),
    list: () => run(async () => kernelAppCatalogRows(await read()), (registry) => registry.list()),
    /** @param {string} appId */
    get: (appId) => run(
      async () => parseKernelAppCatalogRow(await read())?.apps[appId] ?? null,
      (registry) => registry.get(appId),
    ),
    /** @param {string} sessionId */
    getDefaultForSession: (sessionId) => run(
      async () => kernelSessionAppId(await read(), sessionId),
      (registry) => registry.getDefaultForSession(sessionId),
    ),
    /** @param {{name?:unknown,ownerSessionId?:unknown}} input */
    createImported: (input = {}) => run(async () => {
      const state = parseKernelAppCatalogRow(await read()) ?? {
        schemaVersion: 1, apps: {}, sessionDefaults: {},
      };
      const id = newId();
      if (!/^app-[a-z0-9-]{1,92}$/.test(id) || state.apps[id]) {
        throw new Error('invalid or duplicate App id');
      }
      const createdAt = now();
      const record = {
        id,
        name: (typeof input.name === 'string' && input.name.trim()
          ? input.name.trim() : 'Git App').slice(0, 80),
        tags: [], entryFile: 'index.html', fileKinds: {},
        ownerSessionId: typeof input.ownerSessionId === 'string' ? input.ownerSessionId : null,
        createdAt, updatedAt: createdAt, favorite: false,
        source: 'imported', thumbnail: null,
      };
      state.apps[id] = record;
      await idb.put('apps', { key: KERNEL_APP_CATALOG_KEY, value: state });
      return record;
    }, (registry) => registry.create({ ...input, source: 'imported' })),
    /** @param {string} appId */
    remove: (appId) => run(async () => {
      const state = parseKernelAppCatalogRow(await read());
      if (!state?.apps[appId]) return false;
      delete state.apps[appId];
      for (const [sessionId, id] of Object.entries(state.sessionDefaults)) {
        if (id === appId) delete state.sessionDefaults[sessionId];
      }
      await idb.put('apps', { key: KERNEL_APP_CATALOG_KEY, value: state });
      return true;
    }, (registry) => registry.delete(appId)),
    /** @param {string} appId @param {Record<string,unknown>} patch */
    patch: (appId, patch) => patchApp(appId, patch),
    /** @param {string} appId @param {boolean} favorite */
    setFavorite: (appId, favorite) => patchApp(appId, { favorite }),
    /** @param {string} appId @param {string} name */
    setName: (appId, name) => patchApp(appId, { name }),
    /** @param {string} appId @param {string} entryFile */
    setEntryFile: (appId, entryFile) => patchApp(appId, { entryFile }),
    /** @param {string} appId @param {Record<string,'text'|'binary'>} fileKinds */
    setFileKinds: (appId, fileKinds) => {
      const entries = Object.entries(fileKinds ?? {});
      if (entries.length > 256 || entries.some(([path, kind]) => (
        !path || path.length > 512 || (kind !== 'text' && kind !== 'binary')
      ))) throw new TypeError('app-file-kinds-invalid');
      return patchApp(appId, { fileKinds: Object.fromEntries(entries) });
    },
    /** @param {string} sessionId @param {string} appId */
    setDefaultForSession: (sessionId, appId) => run(async () => {
      const state = parseKernelAppCatalogRow(await read());
      if (!state?.apps[appId]) return false;
      state.sessionDefaults[sessionId] = appId;
      await idb.put('apps', { key: KERNEL_APP_CATALOG_KEY, value: state });
      return true;
    }, async (registry) => {
      if (!await registry.get(appId)) return false;
      await registry.setDefaultForSession(sessionId, appId);
      return true;
    }),
  });
};

/** @param {any} deps */
export const makeKernelAppCatalogRoutes = ({
  vault, idb, catalog = createKernelAppCatalog({ idb }), reloadApp = () => {},
  browser = null, appTabUrl = '', sessionCache = undefined,
  isAppSender = () => false, appFiles = undefined, dwebEnabled = false,
}) => Object.freeze({
  'apps/list': async (
    /** @type {{includeActorMetadata?:unknown}} */ { includeActorMetadata } = {},
  ) => {
    if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
    try {
      const apps = await catalog.list();
      if (includeActorMetadata !== true) return { ok: true, apps };
      const described = [];
      // why sequential: a large local catalog must not fan out an unbounded
      // burst of OPFS reads merely because the Hub's Actors view opened.
      for (const app of apps) {
        described.push({ ...app, actor: await describeAppActor(app, appFiles) });
      }
      return { ok: true, apps: described };
    }
    catch (cause) {
      return { ok: false, error: /** @type {{message?:string}} */ (cause)?.message ?? String(cause) };
    }
  },
  'apps/favorite': async (
    /** @type {{appId?:unknown,favorite?:unknown}} */ { appId, favorite } = {},
  ) => {
    if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
    if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
    if (typeof favorite !== 'boolean') return { ok: false, error: 'favorite-boolean-required' };
    try {
      const app = await catalog.setFavorite(appId, favorite);
      return app ? { ok: true, app } : { ok: false, error: 'app-not-found' };
    } catch (cause) {
      return catalogEffectFailure(cause, 'app-favorite-outcome-unknown', 'the favorite update');
    }
  },
  'apps/rename': async (
    /** @type {{appId?:unknown,name?:unknown}} */ { appId, name } = {},
  ) => {
    if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
    if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
    if (typeof name !== 'string' || !name.trim()) return { ok: false, error: 'name-required' };
    try {
      const app = await catalog.setName(appId, name.trim().slice(0, 80));
      if (!app) return { ok: false, error: 'app-not-found' };
      Promise.resolve(reloadApp(appId)).catch(() => {});
      return { ok: true, app };
    } catch (cause) {
      return catalogEffectFailure(cause, 'app-rename-outcome-unknown', 'the App rename');
    }
  },
  'apps/open': async (
    /** @type {{appId?:unknown,surface?:unknown}} */ { appId, surface } = {},
  ) => {
    if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
    if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
    if (surface !== undefined && surface !== 'actor' && surface !== 'edit') {
      return { ok: false, error: 'app-surface-invalid' };
    }
    const app = await catalog.get(appId);
    if (!app) return { ok: false, error: 'app-not-found' };
    const sessionId = await sessionCache?.sessionGet('currentSessionId');
    const owner = typeof sessionId === 'string' ? sessionId
      : typeof app.ownerSessionId === 'string' ? app.ownerSessionId : null;
    const launch = new URLSearchParams();
    if (owner) launch.set('owner', owner);
    if (surface === 'actor' || surface === 'edit') launch.set('surface', surface);
    const url = `${appTabUrl}#${appId}${launch.size ? `?${launch}` : ''}`;
    const existing = (await browser?.tabs?.query?.({ url: `${appTabUrl}#${appId}*` }) ?? [])[0];
    try {
      let surfaceFocused = true;
      if (typeof existing?.id === 'number') {
        await browser.tabs.update(existing.id, { active: true });
        if (surface === 'actor' || surface === 'edit') {
          try {
            const reply = await browser.tabs.sendMessage?.(existing.id, {
              type: 'app/show-surface', appId, surface,
            });
            surfaceFocused = reply?.ok === true;
          } catch { surfaceFocused = false; }
        }
      } else await browser?.tabs?.create?.({ url, active: true });
      if (typeof sessionId === 'string') await catalog.setDefaultForSession(sessionId, appId);
      return { ok: true, ...(surfaceFocused ? {} : { warning: 'app-surface-unavailable' }) };
    } catch (cause) {
      return catalogEffectFailure(cause, 'app-open-outcome-unknown', 'opening the App');
    }
  },
  'app/get-meta': async (
    /** @type {{appId?:unknown}} */ { appId } = {}, /** @type {unknown} */ sender = undefined,
  ) => {
    if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
    if (!isAppSender(sender, appId)) return { ok: false, error: 'app-meta-unauthorized' };
    let app = await catalog.get(appId);
    if (!app) return { ok: false, error: 'app-not-found' };
    let runtimeDweb = app.dweb ?? null;
    let runtimeAgent = { kind: 'bound-app', profile: 'developer', surface: 'code' };
    if (appFiles) {
      try {
        const contract = parseAppManifest(await appFiles.readText(appId, 'peerd.json'));
        const paths = new Set((await appFiles.listApp(appId))
          .map((/** @type {string} */ path) => path.replace(/^\/+/, '')));
        if (!paths.has(contract.entry)) {
          return { ok: false, error: `peerd.json entry is missing: ${contract.entry}` };
        }
        runtimeDweb = contract.capabilities.includes('dweb') && dwebEnabled
          ? (app.dweb ?? { uri: null, publisher: null, hash: null, local: true }) : null;
        runtimeAgent = contract.agent;
        if (contract.entry !== app.entryFile) {
          try { app = await catalog.setEntryFile(appId, contract.entry) ?? app; }
          catch (cause) {
            return catalogEffectFailure(
              cause, 'app-entry-update-outcome-unknown', 'the App entry update',
            );
          }
        }
      } catch (cause) {
        if (/** @type {{name?:unknown}} */ (cause)?.name !== 'NotFoundError') {
          return { ok: false, error: /** @type {{message?:string}} */ (cause)?.message ?? String(cause) };
        }
      }
    }
    return { ok: true, name: app.name, entryFile: app.entryFile,
      fileKinds: app.fileKinds ?? {}, dweb: runtimeDweb, agent: runtimeAgent };
  },
});
