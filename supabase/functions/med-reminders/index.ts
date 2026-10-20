// med-reminders — sends medication reminders to phones, even with the app
// closed. Called every 5 minutes by pg_cron (job "med-reminders"); does
// nothing for anyone else.
//
// Deployed out of band like the rest of the database (no CI). The source
// lives here so it is reviewed and diffed with the app that subscribes.
//
// Reads with the service role, so it sees every family: it must only ever
// send a reminder to someone who has child_access to that child, which
// dueReminders() enforces by walking access rows per subscriber.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { dueReminders, sentKey, type Sub } from './schedule.ts';
import { sendPush, type Vapid } from './webpush.ts';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

// Constant-time compare, so the secret can't be guessed a byte at a time.
function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

Deno.serve(async (req) => {
  // Keys and the cron secret live in the database (get_push_config is
  // granted to service_role only), so there are no function secrets to set.
  const { data: cfg, error: cfgErr } = await db.rpc('get_push_config');
  if (cfgErr || !cfg) return new Response('not configured', { status: 500 });
  if (!same(req.headers.get('x-cron-secret') ?? '', cfg.cron_secret)) {
    return new Response('forbidden', { status: 403 });
  }
  const vapid: Vapid = { publicKey: cfg.vapid_public_key, privateKey: cfg.vapid_private_key, subject: cfg.vapid_subject };

  const { data: subs } = await db.from('push_subscriptions').select('id, auth_id, endpoint, p256dh, auth, time_zone, show_names');
  if (!subs?.length) return Response.json({ subs: 0, sent: 0 });

  const authIds = [...new Set(subs.map((s) => s.auth_id))];
  const { data: access } = await db.from('child_access').select('auth_id, child_id').in('auth_id', authIds);
  const childIds = [...new Set((access ?? []).map((a) => a.child_id))];
  if (!childIds.length) return Response.json({ subs: subs.length, sent: 0 });

  const [{ data: children }, { data: meds }, { data: sentRows }] = await Promise.all([
    db.from('children').select('id, name, is_active').in('id', childIds),
    db.from('medications').select('id, child_id, name, dose, times, type, is_active, start_date, end_date')
      .in('child_id', childIds).eq('is_active', true),
    db.from('push_sent').select('subscription_id, medication_id, dose_date, dose_time')
      .gte('dose_date', new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10)),
  ]);
  const sent = new Set((sentRows ?? []).map((r) => sentKey(r.subscription_id, r.medication_id, r.dose_date, r.dose_time)));

  const due = dueReminders(new Date(), subs as Sub[], access ?? [], children ?? [], meds ?? [], sent);
  let delivered = 0, gone = 0, failed = 0;

  for (const d of due) {
    // Claim before sending: the unique key makes two overlapping runs
    // race for the row, and only the one that inserts it sends.
    const { data: claimed } = await db.from('push_sent')
      .upsert(d.medIds.map((medication_id) => ({
        subscription_id: d.sub.id, medication_id, dose_date: d.doseDate, dose_time: d.doseTime,
      })), { onConflict: 'subscription_id,medication_id,dose_date,dose_time', ignoreDuplicates: true })
      .select('medication_id');
    if (!claimed?.length) continue;

    const s = subs.find((x) => x.id === d.sub.id)!;
    try {
      const r = await sendPush(
        { endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth },
        { title: d.title, body: d.body, tag: `med-${d.childId}-${d.doseTime}`, childId: d.childId, url: '/' },
        vapid,
        // Expire when the dose time passes: a reminder that arrives late is noise.
        { ttl: 15 * 60, urgency: 'high', topic: d.topic },
      );
      if (r.ok) {
        delivered++;
        await db.from('push_subscriptions').update({ last_success_at: new Date().toISOString(), failures: 0 }).eq('id', s.id);
      } else if (r.gone) {
        // The browser unsubscribed or the app was deleted.
        gone++;
        await db.from('push_subscriptions').delete().eq('id', s.id);
      } else {
        failed++;
        await db.rpc('note_push_failure', { p_id: s.id });
      }
    } catch (_e) {
      failed++;
      await db.rpc('note_push_failure', { p_id: s.id });
    }
  }

  // Keep the dedupe table small.
  await db.from('push_sent').delete().lt('dose_date', new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10));

  return Response.json({ subs: subs.length, due: due.length, delivered, gone, failed });
});
