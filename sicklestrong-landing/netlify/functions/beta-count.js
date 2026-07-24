/* netlify/functions/beta-count.js
   ------------------------------------------------------------------
   Returns ONLY aggregate numbers for the public founding-family
   counter — never names, emails, or any personal detail. Reads through
   the `beta_counts` Postgres function using the service-role key (which
   stays server-side). The response is cached briefly for performance. */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FOUNDING_LIMIT = 50;

function json(statusCode, body, cacheSeconds) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": cacheSeconds ? `public, max-age=${cacheSeconds}` : "no-store",
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    // Not configured yet — the page shows its honest fallback message.
    return json(503, { ok: false, error: "not_configured" });
  }

  let resp;
  try {
    resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/beta_counts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
      },
      body: "{}",
    });
  } catch (e) {
    return json(502, { ok: false, error: "upstream" });
  }

  if (!resp.ok) return json(502, { ok: false, error: "upstream" });

  let rows;
  try { rows = await resp.json(); } catch (e) { rows = null; }
  const r = Array.isArray(rows) ? rows[0] : rows;
  if (!r) return json(502, { ok: false, error: "upstream" });

  const founding_count = Number(r.founding_count) || 0;
  const founding_limit = Number(r.founding_limit) || FOUNDING_LIMIT;

  return json(
    200,
    {
      ok: true,
      founding_count,          // aggregate only
      founding_limit,
      spots_remaining: Math.max(0, founding_limit - founding_count),
      waitlist: founding_count >= founding_limit,
      total: Number(r.total) || founding_count,
    },
    60 /* cache 60s */
  );
};
