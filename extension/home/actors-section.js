// @ts-check
// Instance-wide Actor Space. Unlike the compact chat fabric, this full-screen
// monitor intentionally spans every active root session in this peerd instance.
// Its input is the SW-owned projection, never actor-authored claims.

import m from '/vendor/mithril/mithril.js';
import { buildActorFabric } from '/sidepanel/components/actor-fabric-model.js';

/** @typedef {import('/sidepanel/components/actor-fabric-model.js').FabricNode} FabricNode */

const REFRESH_MS = 1_200;

/** @param {string} value */
const inspectorId = (value) => `actor-space-inspector-${value.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

/** @param {string|null|undefined} value */
const displayModel = (value) => {
  const model = String(value ?? '').trim();
  if (!model) return 'model pending';
  const slash = model.lastIndexOf('/');
  return slash >= 0 ? model.slice(slash + 1) : model;
};

/** @param {FabricNode} node */
const nodeStatus = (node) => node.status === 'handed-off' ? 'lineage' : node.status;

/** @param {any} actor */
const actorVersion = (actor) => {
  if (actor?.version?.kind !== 'published') return 'Local working copy';
  const sequence = Number.isSafeInteger(actor.version.sequence)
    ? `release ${actor.version.sequence}` : 'published release';
  const id = typeof actor.version.id === 'string' ? actor.version.id.slice(0, 12) : '';
  return id ? `${sequence} · ${id}` : sequence;
};

/** @param {any} actor */
const actorProvenance = (actor) => {
  if (actor?.provenance?.source === 'dweb') return 'Installed from the Peerd network';
  if (actor?.provenance?.source === 'unsigned-import') return 'Unsigned Git or package import';
  return 'Created locally';
};

/** @param {any} actor */
const actorCapabilities = (actor) => {
  const declared = Array.isArray(actor?.capabilities) ? actor.capabilities : [];
  const runtime = Array.isArray(actor?.runtime) ? actor.runtime : [];
  const labels = [
    ...declared.map((/** @type {string} */ value) => value === 'dweb' ? 'Peerd network backend' : value),
    ...runtime.map((/** @type {string} */ value) => `App ${value}`),
  ];
  return labels.length ? labels.join(', ') : 'App files and local state';
};

/**
 * A durable App definition projected as its existing bound actor. The card
 * deliberately shows declared package metadata separately from effective
 * authority, which is resolved only when a chat binds the actor.
 * @param {any} app
 * @param {{expandedId:string,openingAppId:string,unconfirmedApps:Set<string>,announcement:string,catalogError:string}} ui
 * @param {{openApp:(app:any,surface:'actor'|'edit')=>void|Promise<void>,openApps?:()=>void}} actions
 */
const appActorCard = (app, ui, actions) => {
  const actor = app.actor ?? {};
  const appName = actor.appName ?? 'App';
  const actorName = actor.name ?? `${appName} actor`;
  const expanded = ui.expandedId === actor.id;
  const busy = ui.openingAppId === app.id;
  const opening = !!ui.openingAppId;
  const unconfirmed = ui.unconfirmedApps.has(app.id);
  const publisher = actor?.provenance?.publisher ?? 'unknown';
  const usable = actor.manifest === 'declared' || actor.manifest === 'default';
  const manifestState = actor.manifest === 'invalid'
    ? 'Manifest needs repair'
    : actor.manifest === 'unavailable' ? 'Manifest could not be read'
      : actor.manifest === 'default' ? 'Default App actor contract' : 'Declared in peerd.json';
  return m('article.hub-actor-card', {
    key: actor.id ?? app.id,
    'data-app-actor-id': actor.id ?? `app:${app.id}`,
  }, [
    m('button.hub-actor-card-toggle', {
      type: 'button',
      'aria-expanded': String(expanded),
      'aria-controls': expanded ? `hub-actor-detail-${app.id}` : undefined,
      onclick: () => {
        ui.expandedId = expanded ? '' : actor.id;
        ui.announcement = expanded
          ? `${actorName} details hidden.` : `${actorName} details shown.`;
      },
    }, [
      m('span.hub-actor-glyph', { 'aria-hidden': 'true' }, '◇'),
      m('span.hub-actor-card-copy', [
        m('span.hub-actor-card-kind', 'App actor'),
        m('strong', actorName),
        m('span', `for ${appName}`),
      ]),
      m('span.hub-actor-card-version', actorVersion(actor)),
    ]),
    expanded ? m('.hub-actor-detail', {
      id: `hub-actor-detail-${app.id}`,
      role: 'region', 'aria-label': `Details for ${actorName}`,
    }, [
      actor.manifest === 'invalid' ? m('p.hub-actor-warning', { role: 'alert' },
        'This App declares an invalid actor manifest. Repair peerd.json before trusting or using this actor.') : null,
      actor.manifest === 'unavailable' ? m('p.hub-actor-warning', { role: 'alert' },
        'Peerd could not read this App actor manifest. Refresh before opening or customizing it.') : null,
      m('dl.hub-actor-facts', [
        m('div', [m('dt', 'Model'), m('dd', 'Inherits the owner chat model')]),
        m('div', [m('dt', 'Capabilities'), m('dd', actorCapabilities(actor))]),
        m('div', [m('dt', 'Instructions'), m('dd', actor.instructions?.custom
          ? actor.instructions.preview ?? 'Custom instructions declared in peerd.json'
          : 'Default App actor instructions')]),
        m('div', [m('dt', 'Version'), m('dd', actorVersion(actor))]),
        m('div', [m('dt', 'Publisher'), m('dd', publisher)]),
        m('div', [m('dt', 'Provenance'), m('dd', actorProvenance(actor))]),
        m('div', [m('dt', 'Manifest'), m('dd', manifestState)]),
        m('div', [m('dt', 'Security'), m('dd',
          'Dedicated keyless worker · App-scoped host profile intersected with the owner chat')]),
      ]),
      unconfirmed ? m('.hub-actor-warning', { role: 'alert', 'aria-live': 'assertive' }, [
        m('p', 'Peerd could not confirm whether the previous App open finished. Inspect your tabs before trying again.'),
        m('button.actor-space-open-chat', {
          type: 'button', onclick: () => {
            ui.unconfirmedApps.delete(app.id);
            ui.catalogError = '';
            ui.announcement = `${appName} can be opened again.`;
          },
        }, 'I checked my tabs; allow another open'),
      ]) : null,
      m('.hub-actor-actions', [
        m('button.actor-space-open-chat', {
          type: 'button', disabled: opening || unconfirmed || !usable,
          onclick: () => actions.openApp(app, 'actor'),
        }, busy ? 'Opening…' : 'Chat'),
        m('button.actor-space-open-chat', {
          type: 'button', disabled: opening || unconfirmed || !usable,
          onclick: () => actions.openApp(app, 'edit'),
        }, 'Customize'),
        actions.openApps ? m('button.actor-space-open-chat', {
          type: 'button', onclick: actions.openApps,
        }, 'Manage in Apps') : null,
      ]),
    ]) : null,
  ]);
};

/** @param {FabricNode} node @param {string} selectedId @param {(node: FabricNode) => void} select */
const actorNode = (node, selectedId, select) => m('button.actor-space-node', {
  type: 'button',
  class: `is-${node.variant}${selectedId === node.id ? ' is-selected' : ''}`,
  'data-actor-id': node.id,
  'data-actor-kind': node.variant,
  'aria-pressed': selectedId === node.id ? 'true' : 'false',
  'aria-expanded': selectedId === node.id ? 'true' : 'false',
  'aria-controls': selectedId === node.id ? inspectorId(node.id) : undefined,
  'aria-label': `${node.label}: ${node.name}; ${nodeStatus(node)}`,
  onclick: () => select(node),
}, [
  m('span.peerd-spinner.actor-space-node-orb', { 'aria-hidden': 'true' }),
  m('span.actor-space-node-copy', [
    m('span.actor-space-node-topline', [
      m('span.actor-space-node-kind', node.label),
      m('span.actor-space-node-status', nodeStatus(node)),
    ]),
    m('strong.actor-space-node-task', node.name),
    m('span.actor-space-node-activity', node.activity),
    m('span.actor-space-node-boundary', `${node.boundaryChip} · ${node.scope}`),
  ]),
]);

/**
 * @param {string} parentId
 * @param {Map<string, FabricNode[]>} children
 * @param {string} selectedId
 * @param {(node: FabricNode) => void} select
 * @param {Set<string>} ancestry
 * @returns {any}
 */
const actorBranches = (parentId, children, selectedId, select, ancestry) => {
  const rows = children.get(parentId) ?? [];
  if (rows.length === 0) return null;
  return m('ul.actor-space-branches', rows.map((node) => {
    if (ancestry.has(node.id)) return null;
    const next = new Set(ancestry);
    next.add(node.id);
    return m('li.actor-space-branch', { key: node.id }, [
      actorNode(node, selectedId, select),
      actorBranches(node.id, children, selectedId, select, next),
    ]);
  }));
};

/** @param {FabricNode} node @param {() => void} close */
const inspector = (node, close) => m('aside.actor-space-inspector', {
  id: inspectorId(node.id),
  role: 'region',
  'data-inspector-for': node.id,
  'aria-label': `Inspector for ${node.label}`,
}, [
  m('.actor-space-inspector-head', [
    m('span.actor-space-inspector-kicker', 'Boundary inspector'),
    m('button.actor-space-inspector-close', {
      type: 'button', 'aria-label': 'Close actor inspector', onclick: close,
    }, '×'),
  ]),
  m('h3', node.name),
  m('p.actor-space-inspector-kind', `${node.label} · ${nodeStatus(node)}`),
  m('dl.actor-space-inspector-facts', [
    m('div', [m('dt', 'Now'), m('dd', node.activity)]),
    m('div', [m('dt', 'Access'), m('dd', node.access)]),
    m('div', [m('dt', 'Isolation'), m('dd', node.boundary)]),
  ]),
]);

/**
 * @param {any} root
 * @param {string} selectedId
 * @param {(node: FabricNode) => void} select
 * @param {(sessionId: string) => void|Promise<void>} onOpenSession
 * @param {string|null|undefined} currentSessionId
 * @param {boolean} chatOwnedBySidePanel
 */
const orchestratorRoom = (
  root, selectedId, select, onOpenSession, currentSessionId, chatOwnedBySidePanel,
) => {
  const fabric = buildActorFabric({
    rootSession: root.session,
    actors: root.topology?.actors,
    spawned: root.topology?.spawned,
    asyncTasks: root.topology?.asyncTasks,
  });
  const rootNode = {
    ...fabric.root,
    name: 'Main context',
    activity: root.activity,
  };
  /** @type {Map<string, FabricNode[]>} */
  const children = new Map();
  for (const node of fabric.nodes) {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  const selected = [rootNode, ...fabric.nodes].find((node) => node.id === selectedId) ?? null;
  const label = root.busy ? 'orchestrating' : 'actors active';
  const current = root.session.sessionId === currentSessionId;
  const destination = chatOwnedBySidePanel
    ? (current ? 'Current in side panel' : 'Show in side panel')
    : 'Open here';
  return m('article.actor-space-room', {
    key: root.session.sessionId,
    'data-root-session': root.session.sessionId,
  }, [
    m('header.actor-space-room-head', [
      m('.actor-space-room-identity', [
        m('span.peerd-spinner.actor-space-room-orb', { 'aria-hidden': 'true' }),
        m('div', [
          m('span.actor-space-room-kicker', 'Orchestrator'),
          m('h2', root.session?.title?.trim() || 'Untitled chat'),
        ]),
      ]),
      m('.actor-space-room-actions', [
        m('span.actor-space-room-state', label),
        m('button.actor-space-open-chat', {
          type: 'button',
          disabled: chatOwnedBySidePanel && current,
          onclick: () => onOpenSession(root.session.sessionId),
        }, destination),
      ]),
    ]),
    m('.actor-space-room-meta', [
      m('span', displayModel(root.session?.model)),
      m('span', fabric.activeActors === 1 ? '1 isolated actor' : `${fabric.activeActors} isolated actors`),
      m('span', 'one main context'),
    ]),
    m('p.actor-space-room-now', [m('span', 'Now'), root.activity]),
    m('.actor-space-tree', [
      m('.actor-space-root-wrap', actorNode(
        /** @type {FabricNode} */ (rootNode), selectedId, select,
      )),
      fabric.nodes.length
        ? actorBranches(rootNode.id, children, selectedId, select, new Set([rootNode.id]))
        : m('.actor-space-awaiting', 'No isolated worker has been delegated yet.'),
    ]),
    selected ? inspector(selected, () => select(selected)) : null,
  ]);
};

/**
 * @typedef {Object} ActorSpaceState
 * @property {any|null} overview
 * @property {string} error
 * @property {boolean} loading
 * @property {boolean} inFlight
 * @property {boolean} active
 * @property {string} selectedId
 * @property {any[]|null} catalog
 * @property {string} catalogError
 * @property {boolean} catalogLoading
 * @property {boolean} catalogInFlight
 * @property {string} expandedId
 * @property {string} openingAppId
 * @property {Set<string>} unconfirmedApps
 * @property {string} announcement
 * @property {HTMLElement|null} root
 * @property {ReturnType<typeof setInterval>|null} timer
 * @property {(() => void)|null} onVisibility
 * @property {(manual?: boolean) => Promise<void>} load
 * @property {() => Promise<void>} loadCatalog
 * @property {(app:any,surface:'actor'|'edit') => Promise<void>} openApp
 */

/** @param {any} overview */
const visibleNodeIds = (overview) => {
  const ids = new Set();
  for (const root of Array.isArray(overview?.roots) ? overview.roots : []) {
    const fabric = buildActorFabric({
      rootSession: root.session,
      actors: root.topology?.actors,
      spawned: root.topology?.spawned,
      asyncTasks: root.topology?.asyncTasks,
    });
    ids.add(fabric.root.id);
    for (const node of fabric.nodes) ids.add(node.id);
  }
  return ids;
};

/** @param {any} overview */
const overviewCounts = (overview) => {
  const roots = /** @type {any[]} */ (Array.isArray(overview?.roots) ? overview.roots : []);
  const actors = roots.reduce((/** @type {number} */ sum, /** @type {any} */ root) => sum + buildActorFabric({
    rootSession: root.session,
    actors: root.topology?.actors,
    spawned: root.topology?.spawned,
    asyncTasks: root.topology?.asyncTasks,
  }).activeActors, 0);
  return { roots: roots.length, actors };
};

export const ActorsSection = {
  /** @param {{ state: ActorSpaceState, attrs: {
   *   send: (msg: any) => Promise<any>,
   *   onActiveActorCount?: (count: number) => void,
   * } }} vnode */
  oninit(vnode) {
    const ui = vnode.state;
    ui.overview = null;
    ui.error = '';
    ui.loading = true;
    ui.inFlight = false;
    ui.active = true;
    ui.selectedId = '';
    ui.catalog = null;
    ui.catalogError = '';
    ui.catalogLoading = true;
    ui.catalogInFlight = false;
    ui.expandedId = '';
    ui.openingAppId = '';
    ui.unconfirmedApps = new Set();
    ui.announcement = '';
    ui.root = null;
    ui.timer = null;
    ui.onVisibility = null;
    ui.loadCatalog = async () => {
      if (ui.catalogInFlight) return;
      ui.catalogInFlight = true;
      ui.catalogLoading = true;
      try {
        const result = await vnode.attrs.send({
          type: 'apps/list', includeActorMetadata: true,
        });
        if (result?.ok !== true || !Array.isArray(result.apps)) {
          if (ui.active) ui.catalogError = 'App actors are temporarily unavailable.';
          return;
        }
        if (!ui.active) return;
        ui.catalog = result.apps;
        ui.catalogError = '';
        if (ui.expandedId && !result.apps.some((/** @type {any} */ app) => app.actor?.id === ui.expandedId)) {
          ui.expandedId = '';
        }
      } catch {
        if (ui.active) ui.catalogError = 'App actors are temporarily unavailable.';
      } finally {
        ui.catalogInFlight = false;
        ui.catalogLoading = false;
        if (ui.active) m.redraw();
      }
    };
    ui.openApp = async (app, surface) => {
      if (ui.openingAppId || ui.unconfirmedApps.has(app.id)) return;
      const appName = app.actor?.appName ?? 'App';
      ui.openingAppId = app.id;
      ui.catalogError = '';
      m.redraw();
      let replied = false;
      try {
        const result = await vnode.attrs.send({ type: 'apps/open', appId: app.id, surface });
        replied = result?.ok === true || result?.ok === false;
        if (result?.ok !== true) {
          if (result?.outcomeKnown === false) ui.unconfirmedApps.add(app.id);
          ui.catalogError = ui.unconfirmedApps.has(app.id)
            ? 'The App open could not be confirmed. Inspect your tabs before retrying.'
            : `Could not open ${appName}.`;
          return;
        }
        ui.announcement = result.warning === 'app-surface-unavailable'
          ? `${appName} opened. Use its Actor or Edit control to continue.`
          : `${appName} ${surface === 'actor' ? 'actor chat' : 'editor'} opened.`;
      } catch {
        if (!replied) ui.unconfirmedApps.add(app.id);
        ui.catalogError = ui.unconfirmedApps.has(app.id)
          ? 'The App open could not be confirmed. Inspect your tabs before retrying.'
          : `Could not open ${appName}.`;
      } finally {
        ui.openingAppId = '';
        if (ui.active) m.redraw();
      }
    };
    ui.load = async (manual = false) => {
      if (ui.inFlight) {
        if (manual) {
          ui.announcement = 'Actor activity is already refreshing.';
          m.redraw();
        }
        return;
      }
      ui.inFlight = true;
      const initial = !ui.overview;
      if (manual || initial) ui.loading = true;
      if (manual) ui.announcement = 'Refreshing actor activity.';
      if (manual) m.redraw();
      let moveFocus = false;
      try {
        const result = await vnode.attrs.send({ type: 'actors/overview' });
        if (!result?.ok) throw new Error(result?.error ?? 'overview unavailable');
        if (!ui.active) return;
        const nextIds = visibleNodeIds(result);
        const focused = document.activeElement;
        const focusedActor = focused instanceof Element
          ? focused.closest('.actor-space-node')?.getAttribute('data-actor-id') : null;
        const focusedInspector = focused instanceof Element
          ? focused.closest('.actor-space-inspector') : null;
        if ((focusedActor && !nextIds.has(focusedActor))
          || (focusedInspector && ui.selectedId && !nextIds.has(ui.selectedId))) {
          moveFocus = true;
          ui.announcement = 'Actor finished; focus moved to the monitor controls.';
        }
        if (ui.selectedId && !nextIds.has(ui.selectedId)) ui.selectedId = '';
        ui.overview = result;
        vnode.attrs.onActiveActorCount?.(overviewCounts(result).actors);
        ui.error = '';
        if (manual && !moveFocus) {
          const counts = overviewCounts(result);
          ui.announcement = `Actor activity refreshed. ${counts.roots} orchestrators and ${counts.actors} isolated actors active.`;
        }
      } catch (error) {
        if (!ui.active) return;
        ui.error = error instanceof Error ? error.message : String(error);
        if (manual) ui.announcement = 'Actor activity refresh failed.';
      } finally {
        ui.inFlight = false;
        ui.loading = false;
        if (!ui.active) return;
        m.redraw();
        if (moveFocus) requestAnimationFrame(() => {
          const refresh = ui.root?.querySelector('.actor-space-refresh--live');
          if (refresh instanceof HTMLElement) refresh.focus();
        });
      }
    };
    void ui.loadCatalog();
    void ui.load();
  },

  /** @param {{ state: ActorSpaceState, dom: Element }} vnode */
  oncreate({ state: ui, dom }) {
    ui.root = /** @type {HTMLElement} */ (dom);
    ui.timer = setInterval(() => { if (!document.hidden) void ui.load(); }, REFRESH_MS);
    ui.onVisibility = () => { if (!document.hidden) void ui.load(); };
    document.addEventListener('visibilitychange', ui.onVisibility);
  },

  /** @param {{ state: ActorSpaceState }} vnode */
  onremove({ state: ui }) {
    ui.active = false;
    if (ui.timer) clearInterval(ui.timer);
    if (ui.onVisibility) document.removeEventListener('visibilitychange', ui.onVisibility);
  },

  /**
   * @param {{ state: ActorSpaceState, attrs: {
   *   send: (msg: any) => Promise<any>,
   *   onActiveActorCount?: (count: number) => void,
   *   onOpenSession: (sessionId: string) => void|Promise<void>,
   *   onOpenApps?: () => void,
   *   currentSessionId?: string|null,
   *   chatOwnedBySidePanel?: boolean,
   * } }} vnode
   */
  view({ state: ui, attrs }) {
    const roots = /** @type {any[]} */ (Array.isArray(ui.overview?.roots) ? ui.overview.roots : []);
    const rooms = roots.map((/** @type {any} */ root) => ({
      root,
      fabric: buildActorFabric({
        rootSession: root.session,
        actors: root.topology?.actors,
        spawned: root.topology?.spawned,
        asyncTasks: root.topology?.asyncTasks,
      }),
    })).sort((a, b) => b.fabric.activeActors - a.fabric.activeActors
      || Number(b.root.busy) - Number(a.root.busy)
      || String(a.root.session?.title ?? a.root.session?.sessionId)
        .localeCompare(String(b.root.session?.title ?? b.root.session?.sessionId)));
    const fabrics = rooms.map((room) => room.fabric);
    const catalog = Array.isArray(ui.catalog) ? ui.catalog : [];
    const actorCount = fabrics.reduce((/** @type {number} */ sum, fabric) => sum + fabric.activeActors, 0);
    const boundCount = fabrics.reduce((/** @type {number} */ sum, fabric) => sum
      + fabric.nodes.filter((node) => node.variant === 'bound').length, 0);
    const select = (/** @type {FabricNode} */ node) => {
      const opening = ui.selectedId !== node.id;
      ui.selectedId = opening ? node.id : '';
      ui.announcement = opening
        ? `${node.label} details shown.` : `${node.label} details hidden.`;
      if (!opening) requestAnimationFrame(() => {
        const actor = [...(ui.root?.querySelectorAll('.actor-space-node') ?? [])]
          .find((element) => element.getAttribute('data-actor-id') === node.id);
        if (actor instanceof HTMLElement) actor.focus();
      });
    };

    return m('section.actor-space', { 'aria-labelledby': 'actor-space-title' }, [
      m('header.actor-space-hero', [
        m('.actor-space-hero-copy', [
          m('span.actor-space-eyebrow', 'Peerd Hub'),
          m('h1#actor-space-title', 'Actors'),
          m('p', 'Your durable App actors, plus every live orchestrator and isolated worker in this peerd instance.'),
        ]),
        m('.actor-space-summary', { 'aria-label': 'Actor totals' }, [
          m('.actor-space-stat', [m('strong', ui.catalog === null ? '…' : String(catalog.length)),
            m('span', catalog.length === 1 ? 'App actor' : 'App actors')]),
          m('.actor-space-stat', [m('strong', String(roots.length)),
            m('span', roots.length === 1 ? 'orchestrator' : 'orchestrators')]),
          m('.actor-space-stat', [m('strong', String(actorCount)), m('span', 'isolated actors')]),
          m('.actor-space-stat', [m('strong', String(boundCount)), m('span', 'resource-bound')]),
        ]),
      ]),
      m('section.hub-actor-catalog', { 'aria-labelledby': 'hub-my-actors-title' }, [
        m('.hub-actor-catalog-head', [
          m('div', [
            m('span.actor-space-eyebrow', 'Durable definitions'),
            m('h2#hub-my-actors-title', 'My Actors'),
            m('p', 'Every App brings an actor. Chat with it, customize its manifest and code, or manage the App that owns it.'),
          ]),
          m('button.actor-space-refresh.actor-space-refresh--catalog', {
            type: 'button', disabled: ui.catalogLoading,
            'aria-label': 'Refresh App actors',
            onclick: () => void ui.loadCatalog(),
          }, ui.catalogLoading ? 'Refreshing…' : 'Refresh'),
        ]),
        ui.catalogError ? m('.actor-space-error', { role: 'alert' }, ui.catalogError) : null,
        ui.catalog === null
          ? m('.hub-actor-catalog-empty', ui.catalogLoading
              ? [m('span.peerd-spinner.peerd-spinner--sm', { 'aria-hidden': 'true' }), 'Loading App actors…']
              : 'App actors could not be loaded. Refresh to try again.')
          : catalog.length
            ? m('.hub-actor-grid', catalog.map((app) => appActorCard(app, ui, {
                openApp: ui.openApp,
                openApps: attrs.onOpenApps,
              })))
            : m('.hub-actor-catalog-empty',
                'No durable actors yet. Create or install an App and its actor will appear here.'),
      ]),
      m('.actor-space-live-heading', [
        m('span.actor-space-eyebrow', 'Runtime'),
        m('h2', 'Live activity'),
        m('p', 'Ephemeral, web, compute, and orchestrator actors appear here only while they are running.'),
      ]),
      m('.actor-space-trust-line', [
        m('span.peerd-spinner.peerd-spinner--sm', { 'aria-hidden': 'true' }),
        m('span', 'Live from peerd runtime · worker boundaries are physical, access is server-resolved'),
        m('button.actor-space-refresh.actor-space-refresh--live', {
          type: 'button', disabled: ui.loading, onclick: () => void ui.load(true),
          'aria-label': 'Refresh live actor activity',
        }, ui.loading ? 'Refreshing…' : 'Refresh'),
      ]),
      m('p.sr-only', { 'aria-live': 'polite', 'aria-atomic': 'true' },
        ui.announcement),
      ui.error ? m('.actor-space-error', { role: 'alert' }, `Could not refresh actors: ${ui.error}`) : null,
      ui.loading && !ui.overview
        ? m('.actor-space-loading', [m('span.peerd-spinner', { 'aria-hidden': 'true' }), 'Mapping actors…'])
        : roots.length === 0
          ? m('.actor-space-empty', [
              m('span.peerd-spinner.actor-space-empty-orb', { 'aria-hidden': 'true' }),
              m('h2', 'The instance is quiet'),
              m('p', 'When any chat starts reasoning or delegates work, its orchestrator and actors will appear here.'),
            ])
          : m('.actor-space-rooms', rooms.map(({ root }) => orchestratorRoom(
              root, ui.selectedId, select, attrs.onOpenSession,
              attrs.currentSessionId, attrs.chatOwnedBySidePanel === true,
            ))),
      m('footer.actor-space-legend', [
        m('span.actor-space-legend-root', 'orchestrator · main context'),
        m('span.actor-space-legend-bound', 'solid · resource-bound actor'),
        m('span.actor-space-legend-sub', 'dashed · temporary subactor'),
        m('span', 'fenced replies travel back up'),
      ]),
    ]);
  },
};
