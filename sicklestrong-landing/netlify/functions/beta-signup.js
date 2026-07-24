/* netlify/functions/beta-signup.js
   ------------------------------------------------------------------
   Saves ONE beta signup, then reports back. The Supabase service-role
   key lives ONLY here (from env vars) — never in the browser.

   The heavy lifting (email normalization, de-duplication, and the
   concurrency-safe founding-family assignment) happens inside the
   Postgres function `claim_beta_signup` (see supabase/beta-signups.sql),
   so the 50-family cap can never be exceeded even under simultaneous
   submissions.

   Environment variables (set in Netlify → Site settings → Environment):
     SUPABASE_URL
     SUPABASE_SERVICE_ROLE_KEY
*/

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const CARE_ROLES = new Set([
  "one-child",
  "multiple-children",
  "myself",
  "family-member",
  "caregiver",
]);

const APP_URL = "https://sicklestrong-v2.netlify.app/";
const FB_URL = "https://www.facebook.com/groups/1343740994540360";

// --- abuse protection knobs ---
const MAX_BODY_BYTES = 10 * 1024; // reject request bodies larger than 10 KB
const MAX_UTM_LEN = 150;          // clamp UTM field lengths
// Comma-separated allowlist of origins, e.g. "https://sicklestrong.org".
// If unset, the origin check is skipped (handy for local `netlify dev`).
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";
// NOTE: this file does NOT implement application-level rate limiting. Bot
// protection here = body-size limit + origin allowlist + honeypot + strict
// server-side validation. For request-rate limits, use Netlify's platform
// rate limiting / an edge function (see the README).

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  };
}

const normEmail = (e) => String(e || "").trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;
const clampUtm = (v) => (v ? String(v).slice(0, MAX_UTM_LEN) : null);

function originAllowed(event) {
  if (!ALLOWED_ORIGIN) return true; // not configured → skip the check
  const allow = ALLOWED_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);
  const h = event.headers || {};
  const origin = h.origin || h.Origin || "";
  return !!origin && allow.indexOf(origin) !== -1;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "method_not_allowed", message: "Use POST." });
  }
  // Reject oversized bodies before doing any parsing/work.
  if (event.body && Buffer.byteLength(event.body, "utf8") > MAX_BODY_BYTES) {
    return json(413, { ok: false, error: "too_large", message: "That request was too large." });
  }
  // Origin allowlist (configurable via ALLOWED_ORIGIN; skipped when unset).
  if (!originAllowed(event)) {
    return json(403, { ok: false, error: "forbidden_origin", message: "This request was blocked." });
  }
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    return json(500, {
      ok: false,
      error: "not_configured",
      message: "The signup service is not configured yet.",
    });
  }

  let data;
  try {
    data = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { ok: false, error: "bad_json", message: "Could not read the submission." });
  }

  // Honeypot: real users never fill this hidden field. Accept silently so
  // bots get a success-looking response without a stored record.
  if (data.company) {
    return json(200, { ok: true, duplicate: false, founding_family: false, status: "new" });
  }

  const first_name = String(data.first_name || "").trim();
  const email = normEmail(data.email);
  const care_role = String(data.care_role || "").trim();
  const referral_source = data.referral_source
    ? String(data.referral_source).trim().slice(0, 200)
    : null;
  const consent = data.consent === true || data.consent === "true";
  const utm = data.utm && typeof data.utm === "object" ? data.utm : {};

  // Server-side validation (never trust the browser).
  const errors = {};
  if (!first_name || first_name.length > 80) errors.first_name = "Enter your first name (up to 80 characters).";
  if (!email || !validEmail(email)) errors.email = "Enter a valid email address.";
  if (!CARE_ROLES.has(care_role)) errors.care_role = "Choose who you are managing care for.";
  if (!consent) errors.consent = "Consent is required to join the beta.";
  if (Object.keys(errors).length) return json(400, { ok: false, error: "validation", errors });

  const rpcPayload = {
    p_first_name: first_name,
    p_email: email,
    p_care_role: care_role,
    p_referral_source: referral_source,
    p_utm_source: clampUtm(utm.source),
    p_utm_medium: clampUtm(utm.medium),
    p_utm_campaign: clampUtm(utm.campaign),
  };

  let resp;
  try {
    resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/claim_beta_signup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
      },
      body: JSON.stringify(rpcPayload),
    });
  } catch (e) {
    return json(502, { ok: false, error: "upstream", message: "We could not reach the signup service. Please try again." });
  }

  if (!resp.ok) {
    let detail = "";
    try { detail = (await resp.text()).slice(0, 300); } catch (e) {}
    console.error("Supabase RPC error", resp.status, detail);
    return json(502, { ok: false, error: "upstream", message: "We could not save your signup right now. Please try again." });
  }

  let rows;
  try { rows = await resp.json(); } catch (e) { rows = null; }
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) {
    return json(502, { ok: false, error: "upstream", message: "Unexpected response from the signup service." });
  }

  return json(200, {
    ok: true,
    duplicate: row.out_is_new === false,
    founding_family: !!row.out_founding,
    status: row.out_status || "new",
    app_url: APP_URL,
    facebook_url: FB_URL,
  });
};
