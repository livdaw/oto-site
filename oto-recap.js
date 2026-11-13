// oto-recap.js: the weekly recap, worked out from your own data on your device.
// The same file ships in oto-extension/ (popup) and oto-site/ (web app); keep the copies identical.
//
// A week runs Monday to Sunday, local time. Inputs are plain data, so both apps compute it the same way:
//   thoughts: [{ ts, text, tag, locked? }]  (already decrypted, or marked locked)
//   browser:  { "YYYY-MM-DD": { seconds, prompts, downtime } }  (browser usage, already merged per day)
//   mac:      { "YYYY-MM-DD": { seconds, prompts } }             (Mac app usage)
(function (root) {
  "use strict";
  const DAY = 86400000;
  const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  function mondayOf(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
  function lastWeekStart(now = new Date()) { const m = mondayOf(now); m.setDate(m.getDate() - 7); return m; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

  // the browser figure for a day: the larger of two copies of the same browser data (local and synced)
  function mergeBrowser(local, synced) {
    const out = {}, n = (v) => Number(v) || 0;
    new Set([...Object.keys(local || {}), ...Object.keys(synced || {})]).forEach((k) => {
      const a = (local || {})[k] || {}, b = (synced || {})[k] || {};
      out[k] = { seconds: Math.max(n(a.seconds), n(b.seconds)), prompts: Math.max(n(a.prompts), n(b.prompts)), downtime: Math.max(n(a.downtime), n(b.downtime)) };
    });
    return out;
  }

  function week(start, thoughts, browser, mac) {
    const n = (v) => Number(v) || 0;
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    const from = days[0].getTime(), to = addDays(start, 7).getTime();
    const perDay = days.map((d) => {
      const k = dayKey(d), b = browser[k] || {}, m = mac[k] || {};
      const t0 = d.getTime(), t1 = addDays(d, 1).getTime();
      return { day: k, thoughts: thoughts.filter((t) => t.ts >= t0 && t.ts < t1).length,
               prompts: n(b.prompts) + n(m.prompts), seconds: n(b.seconds) + n(m.seconds), downtime: n(b.downtime) };
    });
    const list = thoughts.filter((t) => t.ts >= from && t.ts < to).sort((a, b) => b.ts - a.ts);
    const tagCount = {}; list.forEach((t) => { if (t.tag) tagCount[t.tag] = (tagCount[t.tag] || 0) + 1; });
    const sum = (f) => perDay.reduce((s, d) => s + d[f], 0);
    return { start: dayKey(start), perDay, thoughts: list,
             tags: Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 8),
             totals: { thoughts: list.length, prompts: sum("prompts"), seconds: sum("seconds"), downtime: sum("downtime") } };
  }

  // { week, previous } for the week starting `start` (default: the last full week)
  function compute({ thoughts = [], browser = {}, mac = {}, start = lastWeekStart() } = {}) {
    const s = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const cur = week(s, thoughts, browser, mac), prev = week(addDays(s, -7), thoughts, browser, mac);
    return { week: cur, previous: { start: prev.start, totals: prev.totals } };
  }
  // was there anything in the last full week? (decides whether a recap is "ready")
  function hasActivity(r) { const t = r.week.totals; return t.thoughts + t.prompts + t.seconds + t.downtime > 0; }

  // the range of days a recap needs (this week and the one before), for fetching usage
  function rangeFor(start = lastWeekStart()) { return { from: dayKey(addDays(start, -7)), to: dayKey(addDays(start, 6)) }; }

  // ---- shared wording, so popup and web say the same thing ----
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function range(startKey) {
    const a = new Date(startKey + "T00:00:00"), b = addDays(a, 6);
    return a.getMonth() === b.getMonth() ? `${a.getDate()}–${b.getDate()} ${MONTHS[a.getMonth()]}`
      : `${a.getDate()} ${MONTHS[a.getMonth()]} – ${b.getDate()} ${MONTHS[b.getMonth()]}`;
  }
  function dur(sec) { sec = Math.round(Number(sec) || 0); const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60); return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`; }
  function headline(t) { return t.thoughts === 0 ? "A quiet week for your own thoughts." : `You kept ${t.thoughts} ${t.thoughts === 1 ? "thought" : "thoughts"} of your own.`; }
  function compare(t, p) {
    const d = t.thoughts - p.thoughts;
    return t.thoughts === 0 ? "Next time you reach for AI, try writing one line first."
      : d > 0 ? `${d} more than the week before.` : d < 0 ? `${-d} fewer than the week before.` : "The same as the week before.";
  }
  function balance(t) {
    const ai = t.seconds, self = t.downtime, both = ai + self, selfPct = both ? Math.round((self / both) * 100) : 50;
    const note = !both ? "No time talking to AI or to yourself recorded last week."
      : !ai ? "You didn't talk to AI at all last week. All of that time was yours."
      : !self ? "No thinking blocks last week. Start one to give yourself some time back."
      : self >= ai ? `You spent more time talking to yourself than to AI: ${selfPct}% of it.`
      : `For every hour talking to AI, you spent ${dur((self / ai) * 3600)} talking to yourself.`;
    return { ai, self, selfPct, both, note };
  }
  // Olivia's catchphrases, word for word (don't add others); drawn with the o/t logo glyphs where shown
  function catchphrase(t, p) { return t.thoughts > p.thoughts ? "AI's not the only one who's self improving" : "See, you don't always need an answer"; }
  // tag cloud sizes: 1.0 to 1.8 between the least and most used
  function cloudScale(tags) {
    const c = tags.map(([, n]) => n), lo = Math.min(...c), hi = Math.max(...c);
    return (n) => (hi === lo ? 1.2 : 1 + 0.8 * ((n - lo) / (hi - lo)));
  }

  root.otoRecap = { dayKey, mondayOf, lastWeekStart, mergeBrowser, compute, hasActivity, rangeFor, range, dur, headline, compare, balance, catchphrase, cloudScale };
})(typeof self !== "undefined" ? self : globalThis);
