# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SickleStrong is an offline-capable PWA that families use to track a child's
sickle cell disease — pain episodes, temperature, medications, hydration,
weight, symptoms, and contacts — and to produce reports for clinicians and
schools. Care is shared: several people (co-parent, grandparent, babysitter)
can be given per-child access at different permission tiers.

## Repository shape

There is no build step, no bundler, no package manager, and no framework. The
entire application is **one file**: `index.html` (~9,600 lines) containing all
markup, CSS, and a single inline `<script>` block. Supporting files are `sw.js`
(service worker), `manifest.json`, and icon PNGs.

Do not introduce a build system, split the app into modules, or add a
dependency without being asked. The single-file, zero-build design is
deliberate: it makes the app trivially cacheable offline and deployable as
static files.

`main` auto-deploys to production (Netlify, `APP_URL` in `index.html`). Treat
any push to `main` as a release.

## Commands

```bash
# Syntax-check the app (there is no linter or compiler)
python3 -c "import re;open('/tmp/c.js','w').write(re.search(r'<script>(.*?)</script>', open('index.html').read(), re.S).group(1))" && node --check /tmp/c.js

# Run the test suites (require Playwright + a Chromium build)
node tests/xss-escaping.test.mjs             # 14 checks — render-site escaping
node tests/storage-resilience.test.mjs       # 11 checks — photo size + save failure
node tests/emergency-medical-record.test.mjs # 22 checks — ER fields in both reports
```

Tests are plain `.mjs` scripts run directly by Node — there is no test runner,
so there is no "run a single test" flag. Each file is one suite; run the file.
All three drive the real `index.html` over `file://` with the Supabase CDN
stubbed, so they need no server and no network. Chromium is located via
`PW_CHROMIUM`, defaulting to `/opt/pw-browsers/chromium`.

The `playwright` package itself must be resolvable from the repo, and this
project has no `node_modules` of its own. Where Playwright is installed
globally but not locally — Claude Code on the web, where it sits in
`/opt/node22/lib/node_modules` — Node's ESM resolver will not find it and every
suite dies with `ERR_MODULE_NOT_FOUND` before opening a browser. Give the
resolver something to walk up to, outside the repo so nothing lands in git:

```bash
ln -sfn /opt/node22/lib/node_modules /home/user/node_modules
```

**Bump `CACHE_VERSION` in `sw.js` when shipping changes** that must reach
already-installed clients — the service worker is network-first for app files
but the version gates cache cleanup.

## Architecture

### Local-first, cloud-second

The app must work fully offline, so **local storage is the source of truth for
the UI** and cloud writes are best-effort:

- `appData` is one in-memory object (children, contacts, settings) persisted to
  `localStorage` under `sickleStrongData` via `saveData()` / `loadData()`.
- Every mutation saves locally **first**, then fires a cloud write through
  `cloudSync(fn)` — fire-and-forget, never blocking the UI, wrapped in
  `_push*` helpers (`_pushPainLog`, `_pushMeds`, `_pushContact`, …).
- `syncAllFromCloud()` pulls on login/session-restore and rebuilds `appData`.
- Boot (`DOMContentLoaded`) wraps all cloud work in `try/catch` — a network
  failure must never stop the setup wizard or main app from rendering.

Consequence: `cloudSync` resolves with `{ error }` rather than throwing, so a
permission denial is invisible to `.catch()` alone. `reportCloudWriteError`
inspects the resolved value and is the only place a user learns their cloud
copy didn't save.

Other `localStorage` keys: `ss_auth` (session mirror), `ss_auth_dismissed`
(suppresses the account prompt), `ss_install_dismissed`, and `ss_accounts` — a
**read-only legacy** pre-Supabase account store; nothing writes it.

Two storage invariants, both fixing real data loss — don't undo either:

- **`saveData()` must never throw.** It catches, warns via `showToast`, and
  returns `false`. Callers save locally then fire the cloud write on the *next*
  line, so a throw here means the cloud write never runs and the entry is lost
  in both places. That entry is typically a pain crisis.
- **Photos go through `compressImageFile()` before storage.** A raw camera
  photo is 3–8 MB against a ~5 MB budget; two of them used to fill storage and
  break every later save. Never store a `readAsDataURL` result directly.

`tests/storage-resilience.test.mjs` pins both.

### Access model — read this before touching sharing

Backing store is Supabase (client created at the top of the main script; the
anon key is public by design, RLS is the real control).

**Every data table is scoped by `child_access`, never by `family_id`.** Being
in a household grants nothing on its own — a caregiver invited to one child
sees that child and no siblings. The Family & Sharing UI copy makes this
promise to users explicitly, so it must stay true.

Two distinct codes, easily confused:

| | Household code (`STRONG-1234`) | Child invite (`INV-XXXXXXXX`) |
|---|---|---|
| Link | `?join=CODE` | `?invite=CODE` |
| Grants | household membership only — **no** record access | access to one child |
| Lifetime | long-lived | 14 days, single use |

An invite always wins over a join code when both are present in a URL.
Household codes are low-entropy, so they sit collapsed behind a `<details>`
disclosure and are deliberately not surfaced on the dashboard.

Permission tiers are `view` < `report` < `full` (`PERMISSION_RANK`), held
**per child** — someone can hold a different tier on each. Gate writes two ways:
`requirePermission('full')` at the top of an action, and `data-requires="..."`
on a control (hidden by `applyPermissionGating()`, which re-runs from
`updateUI()` when the active child changes). The `report` tier exists for the
least-trusted helpers — it allows logging pain and temperature and nothing else.

**Database work is out of band.** The RPCs the frontend calls
(`provision_current_user`, `redeem_child_invite`, `generate_child_invite`,
`lookup_family_by_code`, `switch_household`, `set_child_active_status`,
`delete_child_permanently`, `cancel_child_invite`) and all RLS policies live in
Supabase. There are **no migrations in git**. Do not attempt schema changes;
assume the live database already provides them.

`db/security-model.sql` is a **generated, read-only snapshot** of those policies
and RPCs — a review artifact so the rules can be diffed alongside the frontend
that depends on them. It is **not a migration; never run it.** Regenerate it
with `db/dump-security-model.sql` after any policy change and commit the result,
so a rule that changes without a commit shows up as a diff. `db/README.md`
records the open items found auditing it.

Provisioning is centralized in `ensureUserProvisioned()` because signup with
email confirmation returns **no session** — the user may confirm on a different
device where `localStorage` wouldn't follow. Intent (name, role, pending join
code) therefore rides on the auth user's metadata, and both the login path and
the boot path must provision. Never attempt an authenticated write before a
session exists.

### Rendering and escaping — the rule that matters most

The UI is built by string-templating into `innerHTML`. Because records written
by one person render in another person's browser after sync, **every
user-supplied or cloud-sourced value must be escaped at the point it is
interpolated into HTML**:

```js
`<div>${escapeHtml(child.name)}</div>`          // text and attributes
`${list.map(escapeHtml).join(', ')}`            // arrays
`onclick="fn('${jsArg(contact.phone)}')"`       // JS string inside an attribute
```

Escape **per render site**, never at the sync boundary. The same fields feed
the plain-text `downloadDoctorReport` / `downloadSchoolCareSheet` /
`exportNotes` / `exportAllData` builders, where an escaped `&` would reach a
clinician as a literal `&amp;`. Those four functions, and all
`alert`/`confirm`/toast/`textContent` strings, stay **raw** — escaping them is
a regression.

`jsArg` exists because `escapeHtml` is insufficient when a value sits in a
quoted JS string inside an HTML attribute: the HTML parser decodes entities
back into real quotes before JS runs, so the value can still break out. `jsArg`
hex-escapes against both layers. Neither helper neutralizes a `javascript:`
scheme — if a user value ever needs to reach an `href`/URL position, validate
the scheme instead of escaping.

`tests/xss-escaping.test.mjs` seeds hostile values into the child, pain,
temperature, symptom, medication, weight, note and contact fields and drives 14
render paths, asserting nothing parses into a live DOM node. Its inverse guard
covers **`downloadDoctorReport` and `downloadSchoolCareSheet` only** —
`exportNotes` and `exportAllData` follow the same stay-raw rule but are not
asserted, so a double-escape regression there would not be caught.

It also does **not** assert scheme validation: no user value currently reaches
an `href`/URL position, so there is no such code path to test. If one is ever
added, that test has to be written alongside it — the suite passing is not
evidence the scheme is safe. Run it after touching any render function.

`tests/emergency-medical-record.test.mjs` covers the ER fields a hospital asks
for on arrival — drug allergies, baseline hemoglobin, last transfusion — across
`renderEmergencyInfoCard`, the doctor report and the school care sheet. It
holds the same two lines from the other side: a hostile allergy string must not
become a live node, and the plain-text builders must still emit a raw `&`. Its
real subject is absence, though — an unset field has to read "Not recorded",
never 0, blank or `undefined`, because a clinician must not mistake missing
data for a negative finding.

## Conventions

- Code comments explain **why**, especially where a non-obvious constraint
  forced the design (offline behavior, email-confirmation flows, RLS silently
  matching zero rows). Match that density; don't strip these when editing.
- User-facing copy is written for a worried parent, and share messages are
  written for a recipient who may not know what the app is or that the family
  is dealing with sickle cell disease. American spellings.
- Use `showToast()` for things worth saying but not worth interrupting for;
  `alert()` blocks the whole app and is wrong mid-onboarding.
- Prefer event listeners over inline `onclick` when interpolating user data — a
  name containing a quote would otherwise break out of the attribute.

## graphify

The `graphify` skill (`.claude/skills/graphify/SKILL.md`) builds a knowledge
graph — god nodes, community structure, cross-file relationships — into
`graphify-out/` (gitignored). It needs the `graphify` CLI
(`uv tool install graphifyy`) and is built on demand with `/graphify .`; nothing
below applies until `graphify-out/graph.json` exists.

Rules, once it does:
- For codebase questions, first run `graphify query "<question>"`. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

Note this app is a single ~9,600-line `index.html`, so the graph is thin on
cross-file structure — it is most useful over `db/`, `tests/`, and the docs.

## Playwright MCP

`.mcp.json` registers [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp)
as a project MCP server for driving the app in a real browser — checking a
render path, reproducing a bug, reading console errors. Claude Code asks you to
approve a project server the first time it loads it. It is separate from
`tests/*.test.mjs`, which drive Playwright directly and are the place for
anything that must keep passing.

Two constraints are baked into the flags, both learned the hard way:

- **`--no-sandbox`.** Sessions run as root in a container, where Chromium
  refuses to start with its sandbox on ("Chromium sandboxing failed"). On a
  machine where Chromium *can* sandbox, drop this flag — it is the browser's
  main defense when a page is hostile, and only the container needs it. Note
  the `PLAYWRIGHT_MCP_NO_SANDBOX` env var does **not** work as a substitute
  (tried with `1` and `true`); it has to be the CLI flag.
- **A browser path, per machine.** The server bundles its own Playwright and
  looks for that exact Chromium revision, which will not be the one already on
  the machine, and with no path at all it defaults to the `chrome` channel.
  Point it at the same binary `tests/` uses by setting
  `PLAYWRIGHT_MCP_EXECUTABLE_PATH` in the environment (`/opt/pw-browsers/chromium`
  in Claude Code on the web). That is machine-specific, so it stays out of
  `.mcp.json` — put it in the environment config, or in gitignored
  `.claude/settings.local.json` under `env`.

Navigating to `file://` is blocked unless the server is started with
`--allow-unrestricted-file-access`, which also hands it every file on disk.
Don't add that flag — serve the app instead, which is closer to production
anyway:

```bash
python3 -m http.server 8123 --bind 127.0.0.1   # then browse http://127.0.0.1:8123/index.html
```

Browser calls write snapshots and logs into `.playwright-mcp/` in the working
directory (gitignored).
