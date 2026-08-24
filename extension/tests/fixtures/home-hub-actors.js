// @ts-check
// Deterministic real-component fixture for the Hub Actors visual state.

import m from '/vendor/mithril/mithril.js';
import { ActorsSection } from '/home/actors-section.js';

const app = {
  id: 'fixture-app', name: 'Cohort Board',
  actor: {
    id: 'app:fixture-app', handle: 'fixture-app', appName: 'Cohort Board', name: 'Cohort analyst',
    kind: 'app', model: 'owner-chat', profile: 'developer', surface: 'code',
    runtime: ['observe', 'act'], capabilities: [], manifest: 'declared',
    instructions: {
      custom: true,
      preview: 'Analyze the current cohort chart before changing it.',
    },
    provenance: { source: 'unsigned-import', publisher: 'unsigned import' },
    version: { kind: 'working-copy', id: null, updatedAt: 0 },
    security: {
      boundary: 'dedicated-keyless-worker',
      authority: 'host-profile-intersect-owner',
    },
  },
};

/** @param {{type:string}} message */
const send = async (message) => {
  if (message.type === 'apps/list') return { ok: true, apps: [app] };
  if (message.type === 'actors/overview') return { ok: true, roots: [] };
  return { ok: true };
};

const Fixture = {
  view: () => m('.home-content.home-content--actors',
    m(ActorsSection, { send, onOpenSession: () => {}, onOpenApps: () => {} })),
};

m.mount(document.getElementById('app'), Fixture);
