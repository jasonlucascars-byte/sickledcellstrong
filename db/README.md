# Database security model

The database is managed **out of band**: changes are applied directly in
Supabase, and there are no migrations in this repository. That is a deliberate
choice, but it left a gap — the layer that actually enforces the app's central
privacy promise could not be read, diffed, or code-reviewed alongside the
frontend that depends on it.

These files close that gap.

| File | What it is |
|---|---|
| `security-model.sql` | A **generated snapshot** of the live RLS policies, access helpers, and SECURITY DEFINER RPCs. A review artifact — **not a migration**. Never run it against a database. |
| `dump-security-model.sql` | The read-only query that regenerates the snapshot. |

## Refreshing the snapshot

```bash
psql "$SUPABASE_DB_URL" -At -f db/dump-security-model.sql > db/security-model.sql
```

or paste it into the Supabase SQL editor and save the single text column.

Do this after any change to policies or RPCs, and commit the result. A rule
that changes without an accompanying commit then shows up as a diff, which is
the whole point.

## The promise, and how it is enforced

> Being in a household grants nothing on its own. A caregiver invited to one
> child sees that child and no siblings.

The app states this to families in the Family & Sharing screen, so it has to
stay true. It is enforced by scoping **every table holding a child's health
data** through `child_access` — never through `family_id`:

| Helper | Resolves to |
|---|---|
| `accessible_child_ids()` | every child you hold any access to → gates **reads** |
| `report_access_child_ids()` | `report` + `full` → gates **pain/temperature inserts** |
| `full_access_child_ids()` | `full` only → gates **every other write** |
| `is_parent_of_child()` | `circle_role = 'parent'` → gates **managing the circle** |

Each resolves through `auth.uid()`, so the answer is per signed-in user and
cannot be widened from the client.

Verified against the live database on 2026-08-25: RLS is enabled on all 18
public tables, each with policies, and every health-data table (`pain_logs`,
`temperature_logs`, `symptoms`, `weight_logs`, `medications`,
`medication_logs`, `hydration_logs`, `notes`, `contacts`, `doctor_reports`,
`children`) scopes by `child_access`. **The promise holds.**

Only two tables are family-scoped, and neither holds health data:
`community_posts` and `subscriptions`.

## Open items

Recorded here rather than fixed, because database changes are made out of band.

**1. A guessed household code still lets a *new* account join a household.**
`switch_household()` (used by an existing signed-in user) requires that you
already hold access to a child in that household — a correct-but-guessed code
is refused with `NOT_INVITED_TO_THIS_HOUSEHOLD`. `provision_current_user()`,
which runs at **signup** with a pending join code, has **no equivalent gate**:
it looks the code up and attaches the new user to that `family_id`.

Household codes are low entropy — 8 words × 9000 numbers = 72,000 combinations,
generated with `random()` — and `lookup_family_by_code()` is callable by the
`anon` role, so valid codes can be confirmed cheaply before signing up.

The consequence is bounded: such a user holds **no `child_access` rows**, so
they see no child and no health record of any kind. What they do get is
household membership, which exposes `community_posts` and `subscriptions` for
that family, and makes them a member a real family never invited.

Closing it means applying the same "must already have child access" gate in
`provision_current_user` that `switch_household` already has, or requiring a
child invite for household membership entirely.

**2. Leaked-password protection is disabled.** Supabase can reject passwords
known to be breached (HaveIBeenPwned). It is currently off. Worth enabling now
that password reset exists — it is a dashboard toggle under Authentication.

**3. Advisor warnings about SECURITY DEFINER functions are mostly expected.**
The linter flags every such function callable by `anon`/`authenticated`. Most
are app RPCs that *must* be callable. Three are trigger/event-trigger functions
(`grant_owner_child_access`, `prevent_last_parent_removal`, `rls_auto_enable`)
that cannot do anything useful when invoked directly over REST, since they
require a trigger context. Revoking `EXECUTE` on those three would quiet the
warnings without changing behavior.

`rls_auto_enable` is worth knowing about for a good reason: it is an event
trigger that automatically enables RLS on any new table created in `public`.
That is a genuine safety net against a future table shipping unprotected.
