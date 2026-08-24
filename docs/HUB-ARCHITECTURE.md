# Peerd Hub architecture

The Hub is the full-tab human view in `extension/home/`. It is a UX boundary,
not a sixth `peerd-*` module and not a second source of runtime truth. It makes
three existing concepts legible together:

```text
Peerd Hub
├── Actors
│   ├── My Actors       durable definitions owned by Apps
│   └── Live activity   orchestrators and isolated workers running now
├── Apps                local Apps, their code, data, history, and actor
└── Network
    ├── peers and contacts
    └── Discover        signed, peer-distributed DWApps
```

The implementation keeps the existing dependency graph:

```text
extension/home/ (Hub views)
       │ human routes only
       ▼
background/ vault kernel ───────────────┐
       │                                │
       ▼                                ▼
peerd-engine App registry + OPFS   peerd-runtime actor topology
       │                                │
       ▼                                ▼
engine-tabs/app-tab/ host shell    dedicated keyless actor workers
       │
       └──── optional dweb capability ──► peerd-distributed mesh
                                              │
                                              ▼
                                     signed App bundle exchange
```

## Actors and Apps

An App is the sovereign client-side artifact: its files, local data, history,
UI, and optional network backend. Every App has one App-actor definition. The
definition is declared by `peerd.json`, or uses the legacy default contract when
that file is absent. `peerd-engine/app-manifest.js` is the declaration parser;
`background/app-actor-policy.js` derives provenance and the host-owned grant.

The durable definition is not a permanently running process. Opening actor chat
binds it to an owner chat and creates or reconnects the live actor in the App
tab. The relationship is:

```text
owner chat model
       │ authority ceiling
       ▼
App manifest ──► App actor ──► observe / act / edit App
                    │
                    └────────► fenced reply to owner chat

effective authority = host App profile ∩ manifest methods ∩ owner-chat authority
```

The manifest cannot name tools. It may request only the semantic App runtime
pair supported by the host, and the dispatcher re-checks the effective grant.
The App actor runs in the same dedicated keyless worker boundary as other bound
actors. App code remains in the opaque App frame and cannot open host actor or
editor chrome.

The Actors view asks the vault kernel for a bounded, human-facing projection of
each contract. That projection carries no authority. It shows the owner model,
declared capabilities, instruction preview, version, publisher, provenance,
manifest state, and physical boundary. Chat and Customize route to host-owned
surfaces in the existing App tab, including when the tab is already open.

## Distribution

A DWApp is an App whose manifest declares the existing dweb capability. Sharing
uses the signed, content-addressed bundle and peer discovery already owned by
`peerd-distributed/`; installing writes the verified App into the same App
catalog. Its actor therefore arrives inside the same package and appears in My
Actors without a parallel actor store or package format.

```text
App + peerd.json
       │ share
       ▼
signed content-addressed DWApp ── mesh / DHT ──► verify + install
                                                    │
                                                    ▼
                                      My Apps + My Actors
```

Standalone actor packaging is intentionally not introduced here. If it becomes
useful, it should reuse this signing, addressing, discovery, and install path
rather than creating a second distribution substrate.

## Skills and evaluation

Skills remain active instruction modules for the main agent. Their progressive
disclosure path is implemented by `peerd-runtime/skills/` and their main-agent
prompt boundary by `peerd-runtime/loop/turn-driver.js`. Bound actors deliberately
do not inherit user skills. Skills are therefore not another Hub primitive and
are not removed or renamed by this work.

Evaluation, benchmarks, and red-team suites remain orthogonal verification
surfaces. This slice does not introduce an Actor Evaluation Toolkit or expose
evaluation as runtime authority.

## Extension points

Create, install, App editing, and learning flows may converge on the same App
and actor contracts. The current UI does not promise immutable manifests,
permanent workers, or one fixed creation path. Future surfaces should continue
to derive authority at bind time and keep the Hub a projection over module-owned
state.
