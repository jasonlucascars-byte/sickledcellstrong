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
node tests/xss-escaping.test.mjs             # 19 checks — render-site escaping
node tests/storage-resilience.test.mjs       # 11 checks — photo size + save failure
node tests/emergency-medical-record.test.mjs # 22 checks — emergency fields + ER flag
node tests/delete-account.test.mjs           # 16 checks — in-app account deletion
node tests/sign-out.test.mjs                 # 15 checks — sign out clears the phone safely
node tests/offline-sync.test.mjs             # 27 checks — outbox retry + sync merge
node tests/first-run.test.mjs                # 20 checks — setup wording, phone layout, honest copy
node tests/teen-access.test.mjs              # 11 checks — 13–17 join by parent invite; under 13 blocked
node tests/password-reset.test.mjs           # 16 checks — in-app reset form, clear reasons; invite survives
node tests/logged-by.test.mjs                # 13 checks — "Logged by" names; pain saved as rated 2–10
node tests/teen-approval.test.mjs            # 22 checks — teen self sign-up, parent approval
node tests/quiet-messages.test.mjs           # 26 checks — no alert()/confirm()/prompt(); 14px+ text at 360px
node tests/cloud-edits.test.mjs              # 8 checks — synced records' buttons work; edits/deletes reach the cloud
node tests/push-reminders.test.mjs           # 40 checks — Web Push encryption, reminder schedule, enable/disable
node tests/share-app.test.mjs                # 20 checks — share with another family: no child named, share code, QR decodes
```

`share-app` also needs `npm i --no-save jsqr pngjs` (an independent QR reader).

Tests are plain `.mjs` scripts run directly by Node — there is no test runner,
so there is no "run a single test" flag. Each file is one suite; run the file.
Both drive the real `index.html` over `file://` with the Supabase CDN stubbed,
so they need no server and no network. Chromium is located via `PW_CHROMIUM`,
defaulting to `/opt/pw-browsers/chromium`.

**Bump `CACHE_VERSION` in `sw.js` when shipping changes** that must reach
already-installed clients — the service worker is network-first for app files
but the version gates cache cleanup.

## Architecture

### Local-first, cloud-second

The app must work fully offline, so **local storage is the source of truth for
the UI** and cloud writes are best-effort:

- `appData` is one in-memory object (children, contacts, settings) persisted to
  `localStorage` under `sickleStrongData` via `saveData()` / `loadData()`.
- Every mutation saves locally **first**. **Log entries** (pain, temperature,
  symptom, weight, note, medication) then go through the **outbox**:
  `queueCloudInsert(kind, entry)` — call it after pushing the entry into its
  list and *before* `saveData()` — mints a permanent `entry.cloudId` (sent as
  the row's `id`) and records `{kind, id}` under `ss_outbox`. `flushOutbox()`
  sends queued entries (on queue, on the `online` event, and first thing in
  `syncAllFromCloud`), marks them `synced`, and keeps them queued on network
  failure. A duplicate-key reply means an earlier send landed and counts as
  delivered; RLS or data rejections stop retrying and set `ss_unsynced`.
  Other writes (child profile, contacts, hydration) still use fire-and-forget
  `cloudSync(fn)` via `_push*` helpers.
- `syncAllFromCloud()` pulls on login/session-restore and rebuilds `appData`,
  then **`mergeLocalIntoCloud()`** puts back what only the phone has: queued
  entries, never-uploaded legacy entries (matched to cloud rows by timestamp,
  or medication name, and queued), device-only fields (`photo`, `resolved`,
  `takenToday`, …), today's `waterIntake`/`todayMeds`, and children that never
  reached the cloud. An entry marked `synced` (or carrying a cloud uuid) that
  the cloud no longer has was removed by someone with access and stays gone.
  Never replace this with a plain overwrite: that is the bug that silently
  deleted offline pain crises. `tests/offline-sync.test.mjs` pins it.
- Authorship is stamped by the database: BEFORE INSERT triggers
  (`stamp_logged_by` / `stamp_created_by`) set `logged_by` / `created_by`
  from the signed-in account, overriding anything the app sends. Sync maps it
  to `loggedById` / `loggedByName`; `loggedByHtml()` shows "Logged by <first
  name>" on other people's entries only (`appData.myUserId`). The name comes
  from `users.full_name`, which Settings keeps in step with the name entered
  there.
- Pain is rated 2–10 (faces labeled in ranges, saving the top of each) and
  stored as rated; `pain_logs.severity` is CHECK 1–10. It used to be 1–5 and
  the app clamped to 5, so old cloud rows may read 5 for a 6–10; the merge
  keeps the phone's higher level. Show `painLevelLabel()`, not a bare number.
- Cloud timestamps are `timestamp without time zone` written as UTC; read
  them through `cloudTime()`, or they display hours off.
- Boot (`DOMContentLoaded`) wraps all cloud work in `try/catch` — a network
  failure must never stop the setup wizard or main app from rendering.

Consequence: `cloudSync` resolves with `{ error }` rather than throwing, so a
permission denial is invisible to `.catch()` alone. `reportCloudWriteError`
inspects the resolved value and is the only place a user learns their cloud
copy didn't save.

Other `localStorage` keys: `ss_auth` (session mirror), `ss_auth_dismissed`
(suppresses the account prompt), `ss_install_dismissed`, `ss_outbox` (log
entries waiting to upload — see above), `ss_pending_invite` (an invite code
kept through a password reset, redeemed on the next signed-in open, 14-day
limit), `ss_ref` (a share code from a `?ref=` link, sent as
`referred_by` on sign-up, 30-day limit), `ss_unsynced` (set when a non-queued
write fails or runs offline, or the cloud permanently rejects a queued one;
sign-out warns before erasing either), and `ss_accounts` — a **read-only
legacy** pre-Supabase account store; nothing writes it.

Two storage invariants, both fixing real data loss — don't undo either:

- **`saveData()` must never throw.** It catches, warns via `showToast`, and
  returns `false`. Callers save locally then fire the cloud write on the *next*
  line, so a throw here means the cloud write never runs and the entry is lost
  in both places. That entry is typically a pain crisis.
- **Photos go through `compressImageFile()` before storage.** A raw camera
  photo is 3–8 MB against a ~5 MB budget; two of them used to fill storage and
  break every later save. Never store a `readAsDataURL` result directly.

`tests/storage-resilience.test.mjs` pins both.

### Medication reminders (Web Push)

Reminders 15 minutes before each dose come from the server, so they arrive
with the app closed. The phone subscribes (`savePushSubscription()`, VAPID
public key `VAPID_PUBLIC_KEY` in `index.html`) and hands the subscription to
`save_push_subscription`. Every 5 minutes pg_cron calls the
`med-reminders` edge function (`supabase/functions/med-reminders/`, deployed
out of band, `verify_jwt` off — it checks an `x-cron-secret` header instead).
It reads with the service role, so `schedule.ts` must only remind people who
hold `child_access` to that child; `push_sent` keeps each dose to one push.
The VAPID private key and cron secret live in `private.push_config` (read via
`get_push_config`, service role only) — never commit them; this repo is
public.

- Needs an account (the server only sees cloud medications) and, on iPhone,
  the app added to the Home Screen; the reminders card explains each case.
- Lock screens are public: by default a reminder names the child and the
  time, not the medicine (`show_names`, toggled on the card).
- Sign-out and Clear All Data call `removePushSubscription()` *before*
  signing out, so the next account on the phone never gets the last one's
  children on its lock screen. Deleting the account cascades server-side.
- Medication edits and deletes must reach the cloud (`_pushMedChange`;
  delete = `is_active = false`), or a deleted medicine keeps being reminded.
- `webpush.ts` is Web Crypto only (runs in Deno and Node);
  `tests/push-reminders.test.mjs` decrypts its output independently.

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

Ages: every sign-up asks age and records `age_band` (`18+` / `13-17`) on the
auth user's metadata. Under 13 never gets an account (COPPA). A teen 13–17
gets access to a child **only from a parent**, two ways: a child invite
(`generate_child_invite` lets only a parent create one), or self sign-up then
parent approval — the teen sends a `?approve=TEEN-XXXXXXXX` link from the
waiting screen (`create_teen_request`), and the parent, signed in with the
email the teen named, picks the profile (`approve_teen_request` inserts the
`child_access` row). Until then the `children_block_teen_insert` trigger stops
a teen account creating child profiles, so the waiting screen is a guide, not
the lock. The privacy policy (landing repo, section 2) states these rules, so
change both together.

**Sharing the app is not sharing access.** The Home card "Know a family
facing sickle cell?" (`showShareApp()`) sends a link to the public landing
page (`LANDING_URL?ref=CODE#join`), never to the app, and its message names no
child. A signed-in sharer's link carries their share code (`FAM-XXXXXX`, from
`get_my_referral_code`); a new account that arrived through it records
`referred_by`, and `my_referral_count` returns a count only — never who.
Partner codes (`NURSE-LEXI`) are rows in `referral_codes` with a label and no
account, printed on cards. The landing page keeps `?ref` for 30 days, adds it
to its "Open App" links, and tags beta sign-ups `[ref:CODE]`. The QR code is
drawn by the app's own encoder (`qrEncode`, byte mode, level M, versions
1–10) so it works offline with no dependency.

**Database work is out of band.** The RPCs the frontend calls
(`provision_current_user`, `redeem_child_invite`, `generate_child_invite`,
`lookup_family_by_code`, `switch_household`, `set_child_active_status`,
`delete_child_permanently`, `cancel_child_invite`, `delete_my_account`,
`save_push_subscription`, `remove_push_subscription`, `get_my_referral_code`,
`my_referral_count`) and all RLS policies live in
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
covers all four stay-raw builders, but not all four the same way:

- `downloadDoctorReport`, `downloadSchoolCareSheet` and `exportAllData` are
  checked **behaviorally** — `Blob` is stubbed, the output captured, and the
  raw `&`, `'` and `"` asserted to survive with no HTML entities anywhere.
  Because `exportAllData` serializes `appData` wholesale instead of
  interpolating by hand, that check doubles as a guard on the storage
  invariant: escape at the render site, never at the sync boundary.
- `exportNotes` is checked **statically** — the assertion is that its source
  contains no `escapeHtml(`/`jsArg(` call. It builds a `mailto:` URL and
  assigns `window.location.href`, and that assignment cannot be observed:
  `Location` is [Unforgeable] so the `href` setter can't be stubbed, and an
  unhandled `mailto:` navigation fires no event. A builder that calls no
  escaper, over an `appData` proven raw by the check above, is raw by
  construction — but know that this one guards the *code shape*, not the
  output.

It also does **not** assert scheme validation: no user value currently reaches
an `href`/URL position, so there is no such code path to test. If one is ever
added, that test has to be written alongside it — the suite passing is not
evidence the scheme is safe. Run it after touching any render function.

## Conventions

- Code comments explain **why**, especially where a non-obvious constraint
  forced the design (offline behavior, email-confirmation flows, RLS silently
  matching zero rows). Match that density; don't strip these when editing.
- User-facing copy is written for a worried parent, and share messages are
  written for a recipient who may not know what the app is or that the family
  is dealing with sickle cell disease. American spellings.
- Never call `alert()` or `confirm()` — they freeze sync and the outbox
  until tapped, and some in-app browsers drop them silently. Use
  `notify(message)` (a toast for a short line; a card with OK once the message
  has a paragraph break or runs past ~110 chars) and
  `await askConfirm(message, { okLabel, danger })`, which resolves
  true/false — forgetting the `await` runs the action unconfirmed. Both take
  raw text (set via `textContent`), so don't escape what you pass them.
  `showToast()` is the short-line primitive underneath. Neither uses the
  `.modal` class, on purpose: code that closes every `.modal` must not
  swallow a message. No `prompt()` either: the new password after a reset
  is typed into `showNewPasswordForm()` (hidden by default, Show toggle,
  retries on the same link), and a copy the browser refuses falls back to
  `showCopyFallback()`.
- Text is at least 16px for reading and 14px for labels; form controls
  default to 16px (iPhone zooms into smaller inputs). The one exception is the
  bottom tab bar on phones: 12px, with short names (Log, SOS, Connect) so
  seven fit in 360px. `tests/quiet-messages.test.mjs` checks every tab.
- Record ids are numbers for records made on this phone and uuid strings
  for records from the cloud. Pass them to inline handlers quoted —
  `onclick="fn('${jsArg(rec.id)}')"`, never `fn(${rec.id})`, which is a
  syntax error for a uuid — and compare with `String(a) === String(b)`.
- Prefer event listeners over inline `onclick` when interpolating user data — a
  name containing a quote would otherwise break out of the attribute.
