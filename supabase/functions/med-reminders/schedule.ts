// Decides which reminders are due right now. Pure (no database, no network),
// so tests/push-reminders.test.mjs can drive it with a fixed clock.
//
// The function runs every 5 minutes. A dose at 8:00 is "due for a reminder"
// from 7:45 up to (not including) 8:00 in the phone's own time zone, so
// three runs fall inside that window and the `sent` set — rows already in
// push_sent — stops the second and third from repeating it. A run that is
// late still sends, as long as it lands before the dose time.

export const LEAD_MINUTES = 15;

export interface Sub { id: string; auth_id: string; time_zone: string; show_names: boolean; }
export interface Access { auth_id: string; child_id: string; }
export interface Child { id: string; name: string; is_active: boolean | null; }
export interface Med {
  id: string; child_id: string; name: string; dose: string | null; times: string[] | null;
  type: string | null; is_active: boolean | null; start_date: string | null; end_date: string | null;
}
export interface Due {
  sub: Sub;
  childId: string;
  doseDate: string;  // YYYY-MM-DD, in the subscriber's zone
  doseTime: string;  // HH:MM
  medIds: string[];
  title: string;
  body: string;
  topic: string;     // ≤32 url-safe chars: a newer push replaces an older undelivered one
}

// "As needed" medicines have no schedule to remind about.
const UNSCHEDULED = new Set(['prn', 'as_needed', 'as-needed', 'asneeded', 'asNeeded']);

function localParts(now: Date, tz: string) {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  } catch {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  }
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${ap}`;
}

const firstName = (n: string) => (n || '').trim().split(/\s+/)[0] || 'Your child';

export const sentKey = (subId: string, medId: string, date: string, time: string) => `${subId}|${medId}|${date}|${time}`;

export function dueReminders(
  now: Date, subs: Sub[], access: Access[], children: Child[], meds: Med[], sent: Set<string>,
): Due[] {
  const childById = new Map(children.map((c) => [c.id, c]));
  const medsByChild = new Map<string, Med[]>();
  for (const m of meds) {
    if (m.is_active === false) continue;
    if (m.type && UNSCHEDULED.has(m.type)) continue;
    (medsByChild.get(m.child_id) ?? medsByChild.set(m.child_id, []).get(m.child_id)!).push(m);
  }

  const out: Due[] = [];
  for (const sub of subs) {
    const lp = localParts(now, sub.time_zone);
    // The local wall clock as if it were UTC, so plain arithmetic works.
    const nowLocal = Date.UTC(lp.y, lp.mo - 1, lp.d, lp.h, lp.mi);
    const todayLocal = Date.UTC(lp.y, lp.mo - 1, lp.d);

    for (const a of access.filter((x) => x.auth_id === sub.auth_id)) {
      const child = childById.get(a.child_id);
      if (!child || child.is_active === false) continue;

      const groups = new Map<string, { date: string; time: string; mins: number; meds: Med[] }>();
      for (const med of medsByChild.get(a.child_id) ?? []) {
        for (const t of med.times ?? []) {
          const m = /^(\d{1,2}):(\d{2})/.exec(t);
          if (!m) continue;
          const [hh, mm] = [+m[1], +m[2]];
          if (hh > 23 || mm > 59) continue;
          const time = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
          // Today and tomorrow: a 12:05 AM dose is reminded at 11:50 PM.
          for (const dayStart of [todayLocal, todayLocal + 86400000]) {
            const dose = dayStart + (hh * 60 + mm) * 60000;
            const minsUntil = (dose - nowLocal) / 60000;
            if (minsUntil <= 0 || minsUntil > LEAD_MINUTES) continue;
            const date = ymd(dayStart);
            if (med.start_date && date < med.start_date) continue;
            if (med.end_date && date > med.end_date) continue;
            if (sent.has(sentKey(sub.id, med.id, date, time))) continue;
            const k = `${date} ${time}`;
            (groups.get(k) ?? groups.set(k, { date, time, mins: Math.round(minsUntil), meds: [] }).get(k)!).meds.push(med);
          }
        }
      }

      for (const g of groups.values()) {
        const who = firstName(child.name);
        const when = formatTime(g.time);
        // Lock screens are public. By default the reminder names the child
        // and the time but not the medicines — hydroxyurea or penicillin on
        // a lock screen tells anyone looking that a child has sickle cell.
        // The family can turn names on in the app.
        const body = sub.show_names
          ? g.meds.map((m) => (m.dose ? `${m.name} ${m.dose}` : m.name)).join(', ') + ` · ${when}`
          : `${g.meds.length === 1 ? '1 medicine' : `${g.meds.length} medicines`} due at ${when}. Tap to open SickleStrong.`;
        out.push({
          sub, childId: child.id, doseDate: g.date, doseTime: g.time,
          medIds: g.meds.map((m) => m.id),
          title: `💊 ${who}'s medicine in ${g.mins} minute${g.mins === 1 ? '' : 's'}`,
          body,
          topic: `m${child.id.replace(/-/g, '').slice(0, 20)}${g.time.replace(':', '')}`,
        });
      }
    }
  }
  return out;
}
