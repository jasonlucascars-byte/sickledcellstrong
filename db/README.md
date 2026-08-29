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

**1. ~~A guessed household code lets a *new* account join a household.~~
CLOSED, 29 Aug 2026 — the signup path was retired.**

Household codes are low entropy (8 words × 9000 = 72,000, from `random()`), and
`lookup_family_by_code()` was `anon`-callable, so guesses could be validated for
free. A landed guess put a brand new account inside a real family's household.
No health data was reachable — every health table is scoped by `child_access`
and such a user holds none — but they gained membership nobody granted, plus
that family's `community_posts`.

The obvious fix does not work, and it is worth writing down why. `switch_household()`
refuses a guessed code unless the caller already holds access to a child in that
household. A brand new signup never does, so copying that gate into
`provision_current_user()` would have rejected every legitimate use rather than
securing it. The path had to go rather than be gated.

Retiring it costs nothing, because `redeem_child_invite()` already creates the
profile **and** places the person in the child's household — a child invite
onboards someone completely. The only people the household-code path uniquely
served were those joining a household while seeing no child.

Now: `provision_current_user()` raises `HOUSEHOLD_CODE_SIGNUP_DISABLED` for a
non-empty `p_join_code`, mirroring `LEGACY_CHILD_CODE_DISABLED`; and `anon` has
lost EXECUTE on `lookup_family_by_code()`. `switch_household()` is unchanged and
still serves signed-in users, gated as before.

One trap for whoever revisits this: `REVOKE EXECUTE ... FROM anon` is a **no-op**
here. Postgres grants EXECUTE on a new function to `PUBLIC`, and `anon` inherits
it there rather than holding a direct grant, so the revoke must target `PUBLIC`
and then re-`GRANT` to `authenticated`. The first attempt silently changed
nothing and looked like it had worked.

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
