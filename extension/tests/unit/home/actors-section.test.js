// @ts-check
import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { ActorsSection } from '/home/actors-section.js';

const OVERVIEW = {
  ok: true,
  roots: [{
    session: { sessionId: 'chat-a', title: 'Compare launch plans', model: 'anthropic/sonnet' },
    busy: true,
    activity: 'Coordinating isolated actor work…',
    topology: {
      actors: {
        'tu-web': {
          sessionId: 'web-a', rootSessionId: 'chat-a', parentSessionId: 'chat-a',
          parentToolUseId: 'tu-web', kind: 'web', instanceId: 'web',
          task: 'Read the pricing page', grantedTools: ['read_page'],
          messages: [], streaming: true,
        },
      },
      spawned: { byToolUse: {}, sessions: {
        child: {
          sessionId: 'child', rootSessionId: 'chat-a', parentSessionId: 'chat-a',
          task: 'Compare warranty terms', grantedTools: [], messages: [], running: true,
        },
      } },
      asyncTasks: {},
    },
  }],
};

const APP_CATALOG = [{
  id: 'app-a', name: 'Cohort Board',
  actor: {
    id: 'app:app-a', appName: 'Cohort Board', name: 'Cohort analyst', manifest: 'declared',
    model: 'owner-chat', profile: 'developer', surface: 'code',
    runtime: ['observe', 'act'], capabilities: ['dweb'],
    instructions: { custom: true, preview: 'Analyze the current cohort chart before changing it.' },
    provenance: { source: 'dweb', publisher: 'did:key:publisher' },
    version: { kind: 'published', id: 'abcdef1234567890', sequence: 4 },
  },
}];

/** @param {any} message */
const sendOverview = async (message) => message.type === 'apps/list'
  ? { ok: true, apps: APP_CATALOG } : OVERVIEW;

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  m.redraw.sync();
};

describe('home.actors', () => {
  it('shows every active context and opens an exact boundary inspector', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    /** @type {string[]} */
    const opened = [];
    m.mount(root, { view: () => m(ActorsSection, {
      send: sendOverview,
      onOpenSession: (/** @type {string} */ sessionId) => opened.push(sessionId),
      currentSessionId: 'chat-a',
    }) });
    await flush();
    try {
      expect(root.querySelectorAll('.actor-space-room').length).toBe(1);
      expect(root.querySelectorAll('.actor-space-node').length).toBe(3);
      const stats = root.querySelectorAll('.actor-space-stat');
      expect(stats[0].querySelector('strong')?.textContent).toBe('1');
      expect(stats[0].querySelector('span')?.textContent).toBe('App actor');
      expect(stats[1].querySelector('strong')?.textContent).toBe('1');
      expect(stats[1].querySelector('span')?.textContent).toBe('orchestrator');
      expect(stats[2].querySelector('strong')?.textContent).toBe('2');
      expect(stats[2].querySelector('span')?.textContent).toBe('isolated actors');
      expect(root.querySelector('.actor-space-node.is-bound')).toBeTruthy();
      expect(root.querySelector('.actor-space-node.is-subactor')).toBeTruthy();

      /** @type {HTMLButtonElement} */ (root.querySelector('.actor-space-node.is-bound')).click();
      m.redraw.sync();
      const selected = /** @type {HTMLButtonElement} */ (root.querySelector('.actor-space-node.is-bound'));
      const panel = root.querySelector('.actor-space-inspector');
      expect(panel?.textContent).toContain('one web tab · read_page');
      expect(root.querySelector('.actor-space-inspector')?.textContent).toContain('Dedicated keyless worker');
      expect(selected.getAttribute('aria-expanded')).toBe('true');
      expect(selected.getAttribute('aria-controls')).toBe(panel?.id);
      expect(root.querySelector('[aria-live="polite"]')?.textContent).toContain('details shown');

      selected.focus();
      /** @type {HTMLButtonElement} */ (root.querySelector('.actor-space-inspector-close')).click();
      m.redraw.sync();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(document.activeElement).toBe(selected);
      expect(selected.getAttribute('aria-expanded')).toBe('false');

      /** @type {HTMLButtonElement} */ (root.querySelector('.actor-space-room .actor-space-open-chat')).click();
      expect(opened).toEqual(['chat-a']);
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  it('names the chat destination and announces a manual refresh', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    /** @type {(value: any) => void} */
    let finishRefresh = () => {};
    let overviewCalls = 0;
    const send = async (/** @type {any} */ message) => {
      if (message.type === 'apps/list') return { ok: true, apps: APP_CATALOG };
      overviewCalls += 1;
      if (overviewCalls === 1) return OVERVIEW;
      return new Promise((resolve) => { finishRefresh = resolve; });
    };
    m.mount(root, { view: () => m(ActorsSection, {
      send, onOpenSession: () => {}, currentSessionId: 'chat-a', chatOwnedBySidePanel: true,
    }) });
    await flush();
    try {
      const destination = /** @type {HTMLButtonElement} */ (root.querySelector('.actor-space-open-chat'));
      expect(destination.textContent).toBe('Current in side panel');
      expect(destination.disabled).toBe(true);

      const refresh = /** @type {HTMLButtonElement} */ (root.querySelector('.actor-space-refresh--live'));
      refresh.click();
      m.redraw.sync();
      expect(refresh.textContent).toBe('Refreshing…');
      expect(root.querySelector('[aria-live="polite"]')?.textContent).toContain('Refreshing actor activity');
      finishRefresh(OVERVIEW);
      await flush();
      expect(root.querySelector('[aria-live="polite"]')?.textContent).toContain('Actor activity refreshed');
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  it('moves focus to stable controls when polling removes a running actor', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    let overviewCalls = 0;
    m.mount(root, { view: () => m(ActorsSection, {
      send: async (/** @type {any} */ message) => message.type === 'apps/list'
        ? { ok: true, apps: APP_CATALOG }
        : (++overviewCalls === 1 ? OVERVIEW : { ok: true, roots: [] }),
      onOpenSession: () => {},
    }) });
    await flush();
    try {
      /** @type {HTMLButtonElement} */ (root.querySelector('.actor-space-node.is-subactor')).focus();
      /** @type {HTMLButtonElement} */ (root.querySelector('.actor-space-refresh--live')).click();
      await flush();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(document.activeElement).toBe(root.querySelector('.actor-space-refresh--live'));
      expect(root.querySelector('[aria-live="polite"]')?.textContent).toContain('Actor finished');
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  it('stays useful as a permanent empty monitor', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    m.mount(root, { view: () => m(ActorsSection, {
      send: async (/** @type {any} */ message) => message.type === 'apps/list'
        ? { ok: true, apps: [] } : { ok: true, roots: [] },
      onOpenSession: () => {},
    }) });
    await flush();
    try {
      expect(root.querySelector('.actor-space-empty')?.textContent).toContain('The instance is quiet');
      expect(root.textContent).toContain('durable App actors');
      expect(root.textContent).toContain('No durable actors yet');
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  it('shows the App-owned actor contract and routes Chat and Customize exactly', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    /** @type {any[]} */
    const sent = [];
    let appsOpened = 0;
    const send = async (/** @type {any} */ message) => {
      sent.push(message);
      if (message.type === 'apps/list') return { ok: true, apps: APP_CATALOG };
      if (message.type === 'apps/open') return { ok: true };
      return OVERVIEW;
    };
    m.mount(root, { view: () => m(ActorsSection, {
      send, onOpenSession: () => {}, onOpenApps: () => { appsOpened += 1; },
    }) });
    await flush();
    try {
      const card = root.querySelector('[data-app-actor-id="app:app-a"]');
      expect(card).toBeTruthy();
      /** @type {HTMLButtonElement} */ (card?.querySelector('.hub-actor-card-toggle')).click();
      m.redraw.sync();
      expect(card?.textContent).toContain('Cohort analyst');
      expect(card?.textContent).toContain('Inherits the owner chat model');
      expect(card?.textContent).toContain('Peerd network backend, App observe, App act');
      expect(card?.textContent).toContain('Analyze the current cohort chart');
      expect(card?.textContent).toContain('release 4 · abcdef123456');
      expect(card?.textContent).toContain('did:key:publisher');
      expect(card?.textContent).toContain('Installed from the Peerd network');
      expect(card?.textContent).toContain('Dedicated keyless worker');

      const actions = card?.querySelectorAll('.hub-actor-actions button') ?? [];
      /** @type {HTMLButtonElement} */ (actions[0]).click();
      await flush();
      /** @type {HTMLButtonElement} */ (actions[1]).click();
      await flush();
      /** @type {HTMLButtonElement} */ (actions[2]).click();
      expect(sent.filter((message) => message.type === 'apps/open')).toEqual([
        { type: 'apps/open', appId: 'app-a', surface: 'actor' },
        { type: 'apps/open', appId: 'app-a', surface: 'edit' },
      ]);
      expect(appsOpened).toBe(1);
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  it('does not turn a catalog failure into an empty-catalog claim', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    m.mount(root, { view: () => m(ActorsSection, {
      send: async (/** @type {any} */ message) => message.type === 'apps/list'
        ? { ok: false, error: 'private transport detail' }
        : { ok: true, roots: [] },
      onOpenSession: () => {},
    }) });
    await flush();
    try {
      expect(root.textContent).toContain('App actors are temporarily unavailable');
      expect(root.textContent).toContain('App actors could not be loaded');
      expect(root.textContent.includes('No durable actors yet')).toBe(false);
      expect(root.textContent.includes('private transport detail')).toBe(false);
      expect(root.querySelector('.actor-space-stat strong')?.textContent).toBe('…');
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  it('fences an unconfirmed App open until the user reconciles tabs', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    let opens = 0;
    m.mount(root, { view: () => m(ActorsSection, {
      send: async (/** @type {any} */ message) => {
        if (message.type === 'apps/list') return { ok: true, apps: APP_CATALOG };
        if (message.type === 'apps/open') {
          opens += 1;
          return { ok: false, outcomeKnown: false };
        }
        return { ok: true, roots: [] };
      },
      onOpenSession: () => {},
    }) });
    await flush();
    try {
      const card = root.querySelector('[data-app-actor-id="app:app-a"]');
      /** @type {HTMLButtonElement} */ (card?.querySelector('.hub-actor-card-toggle')).click();
      m.redraw.sync();
      const chat = /** @type {HTMLButtonElement} */ (card?.querySelector('.hub-actor-actions button'));
      chat.click();
      await flush();
      expect(opens).toBe(1);
      expect(chat.disabled).toBe(true);
      expect(card?.textContent).toContain('Inspect your tabs before trying again');
      chat.click();
      expect(opens).toBe(1);
      const reconcile = /** @type {HTMLButtonElement} */ (
        [...card?.querySelectorAll('button') ?? []]
          .find((button) => button.textContent?.includes('I checked my tabs'))
      );
      reconcile.click();
      m.redraw.sync();
      expect(chat.disabled).toBe(false);
      expect(root.querySelector('.actor-space-error')).toBeFalsy();
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  it('treats an App-open transport rejection as unknown and does not replay it', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    let opens = 0;
    m.mount(root, { view: () => m(ActorsSection, {
      send: async (/** @type {any} */ message) => {
        if (message.type === 'apps/list') return { ok: true, apps: APP_CATALOG };
        if (message.type === 'apps/open') {
          opens += 1;
          throw new Error('transport closed');
        }
        return { ok: true, roots: [] };
      },
      onOpenSession: () => {},
    }) });
    await flush();
    try {
      const card = root.querySelector('[data-app-actor-id="app:app-a"]');
      /** @type {HTMLButtonElement} */ (card?.querySelector('.hub-actor-card-toggle')).click();
      m.redraw.sync();
      const chat = /** @type {HTMLButtonElement} */ (card?.querySelector('.hub-actor-actions button'));
      chat.click();
      await flush();
      expect(opens).toBe(1);
      expect(chat.disabled).toBe(true);
      chat.click();
      expect(opens).toBe(1);
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });
});
