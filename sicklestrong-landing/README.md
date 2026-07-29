# SickleStrong — Founding Beta landing page

A production-ready, deployable landing page for the SickleStrong founding beta.
Static HTML/CSS/JS on the front end, with two Netlify Functions and a Supabase
database powering a real beta-signup funnel and an aggregate founding-family
counter.

Brand identity matches the SickleStrong app: teal (`#0EA89A`) → purple
(`#6C3FCF`) signature gradient on a lavender-white ground, with garnet used only
as a restrained sickle-cell-awareness accent. Light and dark themes included.

> **Honesty note:** Out of the box, **no signups are stored** — the form shows a
> friendly "service isn't connected yet" message until you complete the Supabase
> + Netlify setup below and verify it. Do not tell families their data is being
> saved until you have deployed and run the verification steps.

---

## 1. What's in the box

```
index.html                     Landing page (semantic sections, one <h1>)
privacy.html                   Privacy & Data Safety   (draft — needs legal review)
terms.html                     Terms of Use            (draft — needs legal review)
medical-disclaimer.html        Medical Disclaimer      (draft — needs review)
robots.txt  sitemap.xml        Crawl basics (update domain before launch)
netlify.toml                   Netlify config: functions, redirects, headers, CSP
.env.example                   Environment variable template (no secrets)
README.md                      This file

assets/
  css/styles.css               All styling, light + dark themes via tokens
  js/theme.js                  Pre-paint theme (no flash); runs in <head>
  js/analytics.js              Analytics layer — NO fake config (see §7)
  js/main.js                   UI: theme toggle, reveal, FAQ, demo tabs, events
  js/demo.js                   Interactive demo (tap meds, +cup, log sample temp/pain); no sign-up, nothing stored
  js/signup.js                 Form validation + submit + live counter
  img/favicon.svg              SVG favicon (teal→purple heart)
  img/apple-touch-icon.png     Reused from the SickleStrong app
  img/icon-192.png / 512 / maskable-512.png
  img/og-image.svg             Source of the social-sharing image
  img/og-image.png             1200×630 social image (PLACEHOLDER — replace, §9)
  manifest.webmanifest         PWA manifest

netlify/functions/
  beta-signup.js               POST: validate → save via Supabase RPC → confirm
  beta-count.js                GET: aggregate founding-family counts only

supabase/
  beta-signups.sql             Table + RLS + concurrency-safe functions
```

**No `npm install` is required.** The functions use the built-in global `fetch`
(Node 18+). Netlify's default Node runtime already supports this.

---

## 2. Create the Supabase table

1. Create a project at [supabase.com](https://supabase.com) (or use an existing one).
2. Open **SQL Editor → New query**.
3. Paste the entire contents of [`supabase/beta-signups.sql`](supabase/beta-signups.sql) and **Run**.

This creates:

- the **`beta_signups`** table (`id`, `first_name`, unique normalized `email`,
  `care_role`, `referral_source`, `consent_at`, `submitted_at`, UTM fields,
  `status`, `founding_family`);
- **Row Level Security enabled with no public policies** — the anon/public roles
  get zero access; only the service role (used by the functions) can reach it;
- **`claim_beta_signup(...)`** — inserts one signup and de-duplicates by
  normalized email. **Founding-family rule:** the first 50 unique completed
  signups are stored with `founding_family = true` and `status = 'new'`; every
  later unique signup is stored with `founding_family = false` and
  `status = 'waitlisted'`. An advisory lock serializes the assignment so the cap
  of 50 can never be exceeded under concurrent submissions. There is **no
  separate approval step**;
- **`beta_counts()`** — returns aggregate numbers only (no names/emails).

Grab two values from **Project Settings → API**:

- **Project URL** → `SUPABASE_URL`
- **`service_role` secret** → `SUPABASE_SERVICE_ROLE_KEY`
  (⚠️ bypasses RLS — server-side only, never in the browser)

---

## 3. Configure environment variables in Netlify

In the Netlify UI: **Site configuration → Environment variables → Add a variable**
(scope: *Functions*, or all scopes):

| Key | Value |
|---|---|
| `SUPABASE_URL` | `https://YOURPROJECT.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | your Supabase **service_role** key |
| `ALLOWED_ORIGIN` *(optional)* | your site origin(s), e.g. `https://sicklestrong.org` — comma-separate multiple; leave unset to skip the origin check |

Or with the Netlify CLI:

```bash
netlify env:set SUPABASE_URL "https://YOURPROJECT.supabase.co"
netlify env:set SUPABASE_SERVICE_ROLE_KEY "eyJhbGci...your-service-role-key..."
netlify env:set ALLOWED_ORIGIN "https://your-site-domain"   # optional origin allowlist
```

Never commit real values. `.env` is for local use only (see below).

---

## 4. Test locally

You need the Netlify CLI (functions don't run under a plain static server):

```bash
npm install -g netlify-cli        # one time

cp .env.example .env               # then paste your real values into .env
netlify dev                        # serves the site + functions at http://localhost:8888
```

Open <http://localhost:8888>. The page loads, the demo works, and the form
posts to the local functions. Without `.env` values the form returns the
"service isn't connected yet" message — that's expected.

Quick function smoke tests:

```bash
# counter
curl http://localhost:8888/.netlify/functions/beta-count

# signup
curl -X POST http://localhost:8888/.netlify/functions/beta-signup \
  -H "Content-Type: application/json" \
  -d '{"first_name":"Test","email":"test@example.com","care_role":"myself","consent":true}'
```

---

## 5. Deploy to Netlify

**Option A — drag & drop:** unzip this package and drag the `sicklestrong-landing`
folder onto <https://app.netlify.com/drop>. Then set the environment variables
(§3) and redeploy so the functions pick them up.

**Option B — Git + CLI (recommended):**

```bash
netlify init            # link/create a site; publish dir = ".", functions = "netlify/functions"
netlify env:set SUPABASE_URL "..."               # (§3)
netlify env:set SUPABASE_SERVICE_ROLE_KEY "..."
netlify deploy --build --prod
```

`netlify.toml` already declares `publish = "."` and
`functions = "netlify/functions"`, so no extra build settings are needed.

After deploy, update the production domain in `index.html` (canonical + OG URLs),
`robots.txt`, and `sitemap.xml` if you're using a custom domain.

---

## 6. Verification & test scenarios

### Verify a saved signup
1. Submit the form on the deployed site with a **new** email.
2. For one of the first 50, you should see the founding success state:
   *"You're officially a SickleStrong founding family."*
3. In Supabase → **Table Editor → beta_signups**, confirm a new row exists with
   your `first_name`, lowercased `email`, `care_role`, `consent_at`,
   `founding_family = true`, and `status = 'new'`.

Only after seeing the row should you consider signups "working".

### Test duplicate-email handling
1. Submit the **same email** again.
2. The response is friendly and reflects the record's **existing** status —
   *"You're already a SickleStrong founding family."* for a founding record, or
   *"You're already on the SickleStrong waitlist."* for a waitlisted one.
3. In Supabase, confirm **no second row** was created (email is unique) and the
   original `founding_family`/`status` are unchanged.

### Test the founding-family counter
1. Hit `/.netlify/functions/beta-count` (or reload the page). The counter reads,
   e.g., *"49 of 50 founding-family spots remaining."*
2. Add signups and watch `spots_remaining` decrease. The endpoint returns
   **aggregate numbers only** — never names or emails.
3. If the endpoint is unreachable, the page shows the honest fallback:
   *"A limited number of founding-family spots are available."*

### Test the waitlist transition (past 50)
You don't need 50 real people — temporarily lower the cap to test:

1. In `supabase/beta-signups.sql`, change `c_limit constant int := 50;` (and the
   `50` inside `beta_counts()`) to e.g. `2`, and re-run the file.
2. Submit 2 signups → both get `founding_family = true`, `status = 'new'`.
3. Submit a 3rd → it's **still saved** with `founding_family = false` and
   `status = 'waitlisted'`. The success state reads *"You're on the SickleStrong
   waitlist…"*, and the page flips every beta CTA to **"Join the Waitlist"**.
4. Confirm in Supabase that the waitlisted rows have `status = 'waitlisted'`.
5. Restore the cap to `50` and re-run the file when done.

To simulate concurrency, fire several signups at once (e.g. a small `xargs -P`
loop of the curl command); the founding count must never exceed the cap, and
the 50th unique signup must be founding while the 51st is waitlisted.

---

## 7. Analytics (optional, no fake config)

`assets/js/analytics.js` defines a `window.ssTrack(name, props)` layer that sends
**nothing** until you connect a real provider. Until then, events are collected
in `window.ssAnalytics.queue` for inspection — never reported, never faked.

Events already wired:

| Event | Fires when |
|---|---|
| `beta_cta_click` | any primary beta CTA is clicked |
| `demo_open` | the demo is opened / scrolled into view |
| `beta_form_start` | first interaction with the form |
| `beta_form_submit_success` | **after the backend confirms the saved record** |
| `beta_form_submit_error` | client/server validation or save fails |
| `app_open` | an "Open SickleStrong" / Open App link is used |
| `facebook_group_click` | the Facebook community link is used |
| `privacy_page_click` | the Privacy & Data Safety link is opened |

To enable a provider (pick one), then widen the CSP in `netlify.toml`:

- **Plausible** — add `<script defer data-domain="YOURDOMAIN"
  src="https://plausible.io/js/script.js"></script>` to each page `<head>`, and
  add `https://plausible.io` to `script-src` and `connect-src`.
- **GA4** — add the `gtag.js` snippet with your **real** Measurement ID (never a
  placeholder like `G-XXXXXXXXXX`), and add the Google endpoints to the CSP.

The layer auto-detects `window.plausible` / `window.gtag` and forwards events.
The signup conversion (`beta_form_submit_success`) only fires after a confirmed
save — never before.

---

## 8. Security notes

- The Supabase **service-role key lives only in the Netlify Functions**
  (env vars). It never appears in any file served to the browser.
- The `beta_signups` table has **RLS enabled with no public policies**, so the
  anon key (even if you added one) cannot read it. The public counter is served
  through the aggregate-only `beta_counts()` function.
- `netlify.toml` sets a strict **Content Security Policy**. The page's only
  network call is the same-origin form POST (`connect-src 'self'`), so the CSP
  needs no third-party hosts unless you add analytics (§7).
- All external links use `target="_blank" rel="noopener noreferrer"`.

### Abuse protection built into `beta-signup.js`

The function applies, in code:

- **Body-size limit** — requests larger than **10 KB** are rejected (`413`).
- **UTM length clamp** — `utm_source` / `utm_medium` / `utm_campaign` are trimmed
  to **150 chars** before storage.
- **Origin allowlist** — if `ALLOWED_ORIGIN` is set, the request `Origin` header
  must match one of the comma-separated values or the request is rejected
  (`403`). Leave it unset to skip (e.g. local `netlify dev`).
- **Honeypot** — a hidden `company` field; bot-filled submissions are accepted
  silently and **not** stored.
- **Strict server-side validation** — every field is re-validated on the server.

> **Not implemented in code: application-level rate limiting.** Do not describe
> per-IP/request-rate limiting as active — it isn't. Add it at the platform edge:
>
> - **Netlify rate limiting** — configure it on the function/site in the Netlify
>   dashboard (**Site configuration → …**) or with a Netlify **edge function** that
>   rejects excess requests before they reach `beta-signup`. See Netlify's
>   "Rate limiting" docs for the plan/feature availability on your account.
> - **Or** a lightweight store-backed limiter (e.g. Upstash Ratelimit) called from
>   the function. If you add one, remember to widen the CSP/`connect-src` only if
>   the call happens from the browser (it should happen server-side, so no CSP
>   change is needed).

---

## 9. Replacing the social-sharing image

`assets/img/og-image.png` is a **1200×630 placeholder**. To replace it:

- **Easiest:** edit `assets/img/og-image.svg` (text/colors), then re-export a PNG
  at exactly **1200×630** (Figma, Canva, or any SVG→PNG export) and save it over
  `assets/img/og-image.png`. Keep the filename so no HTML changes are needed.
- **Or** drop in your own 1200×630 PNG/JPG at `assets/img/og-image.png`.
- Then update the **absolute** `og:image` / `twitter:image` URLs in `index.html`
  to your production domain (crawlers require absolute URLs), and re-scrape with
  the [Facebook Sharing Debugger](https://developers.facebook.com/tools/debug/)
  and [Twitter/X Card Validator].

Keep it under ~1 MB and avoid essential text near the outer 5% (some platforms
crop). PNG or JPG is required — SVG is not reliably supported for OG images.

---

## 10. Complete the legal / privacy review (required before recruiting)

`privacy.html`, `terms.html`, and `medical-disclaimer.html` are **plain-language
first drafts** and each shows a "Draft for review" banner. Before publishing:

- [ ] Have **qualified legal/privacy counsel** review all three pages for your
      jurisdiction and business structure.
- [ ] Have a **medical/clinical advisor** review the Medical Disclaimer and the
      101.3°F fever wording.
- [ ] Verify every privacy claim against the **actual implementation** — data in
      transit, at rest, browser storage, logs, backups, and exports — before
      making any security statement. Do **not** claim HIPAA compliance, complete
      encryption, absolute security, or total isolation unless independently
      verified.
- [ ] Replace placeholder contact addresses (`privacy@sicklestrong.app`,
      `hello@sicklestrong.app`) with monitored inboxes.
- [ ] Confirm the local-only vs. family-account/cloud-sync vs. landing-analytics
      descriptions match how the app actually behaves.
- [ ] Remove each draft banner only after sign-off.

---

## 11. Final accessibility & mobile checklist

- [ ] One `<h1>` per page; logical `<h2>`/`<h3>` order.
- [ ] Every form control has a **visible label**; errors are announced (`role="alert"`).
- [ ] FAQ is keyboard operable; triggers use `aria-expanded` + `aria-controls`.
- [ ] Demo tabs use `role="tablist"`/`tab`/`tabpanel` with arrow-key navigation.
- [ ] Visible focus outlines on all interactive elements.
- [ ] Touch targets ≥ **44×44px**.
- [ ] Color contrast meets **WCAG AA** in both light and dark themes.
- [ ] `prefers-reduced-motion` disables reveals/animation.
- [ ] Page content is **readable with JavaScript disabled** (demo shows both
      profiles; FAQ answers visible; links work).
- [ ] Test at **320px, 375px, 390px, 768px, and desktop** widths; the mobile hero
      keeps the product preview, and a sticky "Join" bar appears after the hero.
- [ ] Run Lighthouse / axe DevTools and address any AA issues before launch.

---

## 12. Housekeeping before launch

- [ ] Replace `https://sicklestrong-landing-v2.netlify.app/` with your production
      domain in: `index.html` (canonical + OG/Twitter URLs), `privacy.html`,
      `terms.html`, `medical-disclaimer.html`, `robots.txt`, `sitemap.xml`.
- [ ] Confirm the app link (`https://sicklestrong-v2.netlify.app/`) and Facebook
      group (`https://www.facebook.com/groups/1343740994540360`) are correct.
- [ ] Set `ALLOWED_ORIGIN` to your production origin(s) and add platform rate
      limiting (§8) before a public push.
- [ ] Founding-family rule is fixed: the first 50 unique completed signups get
      `founding_family = true`; later signups are `waitlisted`. No approval step
      is implemented — don't add approval wording unless you build one.
- [ ] The UI does **not** promise a confirmation email. If you later add one
      (e.g. a Supabase trigger or email provider), only then update the copy to
      mention email — and add an unsubscribe path before promising updates.
