// Dashboard metric calculations. Pure functions over public/data/dashboard.json; shared with tests.
// Conventions: months are indexed 1..24 (Month 1 = data.first_month). Subscription periods cover
// [start_date, end_date) — end_date is the first day without service. "At month m" = at the last day of m.

export function monthIso(data, m) { // first day of month m (m may be 0 or 25+)
  const [y, mo] = data.first_month.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1 + m - 1, 1)).toISOString().slice(0, 10);
}
const inMonth = (data, date, m) => date >= monthIso(data, m) && date < monthIso(data, m + 1);
const activeAtEnd = (data, row, m) => { const next = monthIso(data, m + 1); return row.start_date < next && (row.end_date == null || row.end_date >= next); };
export const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const sum = xs => xs.reduce((a, b) => a + b, 0);
export const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** Active subscribed facilities at the end of month m: Map facility_id -> subscription period. */
export function subscribedAt(data, m) {
  const out = new Map();
  for (const s of data.subscriptions) if (activeAtEnd(data, s, m)) out.set(s.facility_id, s);
  return out;
}

/** Monthly-equivalent recurring revenue of one subscription period (plan only). */
export function planMrr(data, s) {
  const plan = data.plans.find(p => p.plan_id === s.plan_id);
  return plan.list_price * (1 - s.discount_pct) * (s.billing_cycle === 'annual' ? 1 - data.assumptions.annual_discount : 1);
}

/** MRR at end of month m = active plan subscriptions + active RECURRING add-ons. Tokens excluded. */
export function mrrAt(data, m) {
  const subs = subscribedAt(data, m);
  let plan = 0, addon = 0;
  for (const s of subs.values()) plan += planMrr(data, s);
  for (const a of data.subscription_addons) {
    const def = data.addons.find(x => x.addon_id === a.addon_id);
    if (def.recurring && subs.has(a.facility_id) && activeAtEnd(data, a, m)) addon += def.price * a.quantity;
  }
  return { plan, addon, total: plan + addon };
}

const firstStart = data => {
  const out = new Map();
  for (const s of data.subscriptions) if (!out.has(s.facility_id) || s.start_date < out.get(s.facility_id)) out.set(s.facility_id, s.start_date);
  return out;
};
/** Facilities whose FIRST subscription began in month m. */
export function newFacilities(data, m) {
  return [...firstStart(data)].filter(([, d]) => inMonth(data, d, m)).map(([f]) => f);
}
/** Cancelled periods (final, no successor) with end_date in month m, i.e. not subscribed at end of m. */
export function churnedIn(data, m) {
  return data.subscriptions.filter(s => s.end_reason === 'cancelled' && inMonth(data, s.end_date, m));
}
/** Churn over months a..b = cancellations / facilities subscribed at the start of each month (end of m-1). */
export function churnRate(data, a, b, planId = null) {
  let churned = 0, base = 0;
  for (const m of range(a, b)) {
    base += [...subscribedAt(data, m - 1).values()].filter(s => !planId || s.plan_id === planId).length;
    churned += churnedIn(data, m).filter(s => !planId || s.plan_id === planId).length;
  }
  return { churned, base, rate: base ? churned / base : null };
}

export const usageIn = (data, a, b) => data.usage.filter(r => r.m >= a && r.m <= b);
/** Monthly active facility: >=1 patient encounter recorded in the calendar month. */
export const monthlyActive = (data, m) => data.usage.filter(r => r.m === m && r.enc > 0).length;

/** KPI values for months a..b; prior = preceding equivalent window (null where outside the data). */
export function kpis(data, a, b) {
  const calc = (a, b) => ({
    subscribed: subscribedAt(data, b).size,
    mrr: mrrAt(data, b).total,
    newFacilities: sum(range(a, b).map(m => newFacilities(data, m).length)),
    churn: churnRate(data, a, b).rate,
    mau: monthlyActive(data, b),
    encounters: sum(usageIn(data, a, b).map(r => r.enc)),
  });
  const len = b - a + 1;
  return { current: calc(a, b), prior: a - len >= 1 ? calc(a - len, a - 1) : null };
}

/**
 * MRR forecast: linear trend anchored at the last observation.
 * slope = least-squares slope of the trailing `window` months; F(T+h) = y_T + slope*h, floored at 0.
 * 80% band: ±1.2816·σ·√h, σ = std. dev. of month-over-month changes around the slope.
 * Uses only the `history` array passed in.
 */
export function forecastMrr(history, horizon = 6, window = 12) {
  const ys = history.slice(-window), n = ys.length, T = history.length;
  const xbar = (n - 1) / 2, ybar = sum(ys) / n;
  const slope = n > 1 ? sum(ys.map((y, i) => (i - xbar) * (y - ybar))) / sum(ys.map((_, i) => (i - xbar) ** 2)) : 0;
  const diffs = ys.slice(1).map((y, i) => y - ys[i] - slope);
  const sigma = diffs.length > 1 ? Math.sqrt(sum(diffs.map(d => d * d)) / (diffs.length - 1)) : 0;
  const last = history[T - 1];
  return range(1, horizon).map(h => {
    const mid = last + slope * h, w = 1.2816 * sigma * Math.sqrt(h);
    return { month: T + h, value: Math.max(0, mid), low: Math.max(0, mid - w), high: Math.max(0, mid + w) };
  }).map(p => ({ ...p, slope, sigma }));
}

/**
 * Holdout backtest of the same method: fit on all but the last `test` months, forecast those months,
 * compare with the actuals. MAPE = mean |actual − forecast| ÷ actual over the test months.
 */
export function backtestMrr(history, test = 4, window = 12) {
  const train = history.slice(0, -test), actual = history.slice(-test);
  const forecast = forecastMrr(train, test, window);
  const errs = forecast.map((p, i) => actual[i] > 0 ? Math.abs(actual[i] - p.value) / actual[i] : null).filter(e => e != null);
  return { trainEnd: train.length, forecast, actual, mape: errs.length ? sum(errs) / errs.length : null };
}

// ---------------- Product usage ----------------
export const sizeBand = docs => docs <= 1 ? '1 doctor' : docs <= 3 ? '2–3 doctors' : '4+ doctors';

/** Usage intensity per segment over months a..b. Volume normalised per rostered doctor. */
export function usageBySegment(data, a, b) {
  const subs = new Map(); // plan in force at the end of each month (or last period in month)
  const rows = usageIn(data, a, b);
  const planOf = r => { const k = r.m; if (!subs.has(k)) subs.set(k, subscribedAt(data, k)); return subs.get(k).get(r.f)?.plan_id ?? null; };
  const seg = (label, filter) => {
    const rs = rows.filter(filter);
    if (!rs.length) return { label, n: 0 };
    return {
      label, n: rs.length,
      activeShare: rs.filter(r => r.enc > 0).length / rs.length,
      activeDays: median(rs.map(r => r.active_days)),
      encPerDoctor: median(rs.map(r => r.enc / r.rostered)),
      modules: median(rs.map(r => r.modules.length)),
    };
  };
  return [
    ...data.plans.map(p => seg(p.name, r => planOf(r) === p.plan_id)),
    ...['1 doctor', '2–3 doctors', '4+ doctors'].map(s => seg(s, r => sizeBand(r.rostered) === s)),
  ];
}

/** Share of subscribed facilities (with a usage row) using each module in month m. */
export function moduleAdoption(data, m) {
  const rows = data.usage.filter(r => r.m === m);
  return data.modules.map(mod => ({ module: mod, share: rows.length ? rows.filter(r => r.modules.includes(mod)).length / rows.length : null }));
}

// ---------------- Retention diagnostics (observable data only) ----------------
const facilityRows = data => { const map = new Map(); for (const r of data.usage) { if (!map.has(r.f)) map.set(r.f, new Map()); map.get(r.f).set(r.m, r); } return map; };
const engagement = rs => ({
  activeDays: median(rs.map(r => r.active_days)),
  encPerDoctor: median(rs.map(r => r.enc / r.rostered)),
  modules: median(rs.map(r => r.modules.length)),
});

/**
 * Compare churned vs retained facilities on two observation windows:
 *  - first 3 full months after onboarding (facilities onboarded inside the data window)
 *  - final 3 months observed (churned: 3 months before cancellation; retained: Months 22–24)
 * Per-facility means first, then the median across facilities.
 */
export function retainedVsChurned(data) {
  const N = data.months.length, fr = facilityRows(data), starts = firstStart(data);
  const cancelled = new Map(data.subscriptions.filter(s => s.end_reason === 'cancelled').map(s => [s.facility_id, s]));
  const retained = new Set(subscribedAt(data, N).keys());
  const window = (f, ms) => { const rows = ms.map(m => fr.get(f)?.get(m)); return rows.every(Boolean) ? rows : null; };
  const perFacility = (rows) => ({ activeDays: sum(rows.map(r => r.active_days)) / rows.length, encPerDoctor: sum(rows.map(r => r.enc / r.rostered)) / rows.length, modules: sum(rows.map(r => r.modules.length)) / rows.length });
  const groups = { churned: { first: [], last: [] }, retained: { first: [], last: [] } };
  for (const f of fr.keys()) {
    const g = cancelled.has(f) ? 'churned' : retained.has(f) ? 'retained' : null;
    if (!g) continue;
    const s0 = data.months.findIndex(x => x.key === starts.get(f).slice(0, 7)) + 1; // 0 => onboarded before window
    const end = g === 'churned' ? data.months.findIndex(x => x.key === cancelled.get(f).end_date.slice(0, 7)) : N; // last served month
    const first = s0 >= 1 ? window(f, range(s0 + 1, s0 + 3)) : null;
    if (first && s0 + 3 <= end) groups[g].first.push(perFacility(first));
    const last = end >= 3 ? window(f, range(end - 2, end)) : null;
    if (last && (s0 < 1 || end - 2 > s0)) groups[g].last.push(perFacility(last));
  }
  const summarise = list => ({ n: list.length, activeDays: median(list.map(x => x.activeDays)), encPerDoctor: median(list.map(x => x.encPerDoctor)), modules: median(list.map(x => x.modules)) });
  const allLast = [...groups.churned.last, ...groups.retained.last].map(x => x.encPerDoctor);
  const med = median(allLast);
  return {
    churned: { first: summarise(groups.churned.first), last: summarise(groups.churned.last) },
    retained: { first: summarise(groups.retained.first), last: summarise(groups.retained.last) },
    churnedAboveMedianShare: groups.churned.last.length ? groups.churned.last.filter(x => x.encPerDoctor > med).length / groups.churned.last.length : null,
  };
}

/**
 * Activity in the 6 months before cancellation, each facility indexed to its own mean over those
 * 6 months (=100), so large and small facilities are comparable. Retained comparison: Months 19–24.
 * Only facilities with all 6 months observed are included.
 */
export function preChurnTrajectory(data) {
  const N = data.months.length, fr = facilityRows(data);
  const series = (f, end) => {
    const rows = range(end - 5, end).map(m => fr.get(f)?.get(m));
    if (!rows.every(Boolean)) return null;
    const v = rows.map(r => r.enc / r.rostered), mean = sum(v) / v.length;
    return mean > 0 ? v.map(x => 100 * x / mean) : null;
  };
  const churned = [], retained = [];
  for (const s of data.subscriptions.filter(s => s.end_reason === 'cancelled')) {
    const end = data.months.findIndex(x => x.key === s.end_date.slice(0, 7)); // last served month index
    const v = end >= 6 ? series(s.facility_id, end) : null;
    if (v) churned.push(v);
  }
  for (const f of subscribedAt(data, N).keys()) { const v = series(f, N); if (v) retained.push(v); }
  const col = (list, i) => median(list.map(v => v[i]));
  return { offsets: [-6, -5, -4, -3, -2, -1], churned: range(0, 5).map(i => col(churned, i)), retained: range(0, 5).map(i => col(retained, i)), nChurned: churned.length, nRetained: retained.length };
}

/** Monthly churn rate by module breadth in the PRECEDING month (lagged, observable). Months 2..24. */
export function churnByBreadth(data) {
  const N = data.months.length, fr = facilityRows(data);
  const bands = [['0–2 modules', 0, 2], ['3–4 modules', 3, 4], ['5–7 modules', 5, 7]].map(([label, lo, hi]) => ({ label, lo, hi, base: 0, churned: 0 }));
  for (const m of range(2, N)) {
    const churned = new Set(churnedIn(data, m).map(s => s.facility_id));
    for (const f of subscribedAt(data, m - 1).keys()) {
      const prev = fr.get(f)?.get(m - 1);
      if (!prev) continue;
      const b = bands.find(b => prev.modules.length >= b.lo && prev.modules.length <= b.hi);
      b.base++; if (churned.has(f)) b.churned++;
    }
  }
  return bands.map(b => ({ ...b, rate: b.base ? b.churned / b.base : null }));
}

// ---------------- Acquisition funnel & marketing channels ----------------
export const STAGES = [['engaged_date', 'Engaged'], ['inquired_date', 'Inquired'], ['demo_date', 'Demo'], ['trial_start_date', 'Free trial'], ['converted_date', 'Converted']];
const STAGE_DROP = ['No inquiry', 'No demo', 'No trial', 'Not converted'];
export const RESUB_DAYS = 90;
const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

/** Leads (funnel cohort) whose first engagement falls in months a..b. */
export const leadsIn = (data, a, b, channel = null) =>
  data.leads.filter(l => l.engaged_date >= monthIso(data, a) && l.engaged_date < monthIso(data, b + 1) && (!channel || l.channel === channel));

/** Converted lead -> 'resubscribed' (facility still subscribed 90 days after conversion), 'cancelled', or 'too_recent'. */
export function resubStatus(data, lead) {
  const d = addDays(lead.converted_date, RESUB_DAYS);
  if (d >= monthIso(data, data.months.length + 1)) return 'too_recent';
  return data.subscriptions.some(s => s.facility_id === lead.facility_id && s.start_date <= d && (s.end_date == null || d < s.end_date)) ? 'resubscribed' : 'cancelled';
}

/** Stage counts for a set of leads. A lead counts at every stage it reached by the end of the data. */
export function funnelCounts(data, leads) {
  const out = Object.fromEntries(STAGES.map(([col]) => [col, leads.filter(l => l[col] != null).length]));
  const conv = leads.filter(l => l.converted_date).map(l => resubStatus(data, l));
  return { ...out, open: leads.filter(l => l.outcome === 'open').length, wonBack: leads.filter(l => l.outcome === 'won_back').length, resubscribed: conv.filter(s => s === 'resubscribed').length, cancelled: conv.filter(s => s === 'cancelled').length, tooRecent: conv.filter(s => s === 'too_recent').length };
}

/** Last stage a lead reached (column name). */
const lastStage = l => [...STAGES].reverse().find(([col]) => l[col] != null)[0];

/**
 * Sankey flows: channel -> Engaged -> ... -> Converted, with drop-off exits. "Re-subscribed" receives
 * converted facilities still paying after 90 days AND lapsed leads (no demo / no trial / not converted)
 * that came back and subscribed later (won back). Leads still in progress, and conversions too recent to
 * judge, are left out of the flows (counts in `open` and `tooRecent`).
 */
export function funnelSankey(data, a, b) {
  const leads = leadsIn(data, a, b), flows = [];
  const add = (from, to, flow) => { if (flow > 0) flows.push({ from, to, flow }); };
  for (const c of data.channels) add(c.name, 'Engaged', leads.filter(l => l.channel === c.channel).length);
  STAGES.slice(0, -1).forEach(([col, label], i) => {
    const [nextCol, nextLabel] = STAGES[i + 1];
    add(label, nextLabel, leads.filter(l => l[nextCol] != null).length);
    add(label, STAGE_DROP[i], leads.filter(l => l[col] != null && l[nextCol] == null && l.outcome !== 'open').length);
  });
  STAGES.slice(1).forEach(([col], i) => add(STAGE_DROP[i], 'Re-subscribed', leads.filter(l => l.outcome === 'won_back' && STAGES[STAGES.findIndex(s => s[0] === lastStage(l)) + 1][0] === col).length));
  const f = funnelCounts(data, leads);
  add('Converted', 'Re-subscribed', f.resubscribed);
  add('Converted', `Cancelled ≤ ${RESUB_DAYS} days`, f.cancelled);
  const column = { Engaged: 1, Inquired: 2, 'No inquiry': 2, Demo: 3, 'No demo': 3, 'Free trial': 4, 'No trial': 4, Converted: 5, 'Not converted': 5, 'Re-subscribed': 6, [`Cancelled ≤ ${RESUB_DAYS} days`]: 6, 'Too recent to tell': 6 };
  for (const c of data.channels) column[c.name] = 0;
  return { flows, column, total: leads.length, open: f.open, tooRecent: f.tooRecent };
}

const inMonths = (data, a, b) => r => r.month >= monthIso(data, a).slice(0, 7) && r.month < monthIso(data, b + 1).slice(0, 7);

/** Top-of-funnel volume for a channel in months a..b: site sessions (digital), calls made, or referrals received (= referral leads). */
export function channelVolume(data, c, a, b) {
  if (c.channel === 'cold_calling') return sum(data.outbound_calls.filter(inMonths(data, a, b)).map(r => r.calls_made));
  if (c.channel === 'referral') return leadsIn(data, a, b, 'referral').length;
  const source = c.channel === 'website' ? 'organic_direct' : c.channel;
  return sum(data.website_traffic.filter(r => r.source === source && inMonths(data, a, b)(r)).map(r => r.sessions));
}

/** Per-channel funnel and revenue for the lead cohort engaged in months a..b. Plan MRR = at end of b, from facilities converted from these leads. */
export function channelSummary(data, a, b) {
  const subsEnd = subscribedAt(data, b);
  const rows = data.channels.map(c => {
    const leads = leadsIn(data, a, b, c.channel), f = funnelCounts(data, leads);
    const volume = channelVolume(data, c, a, b), matured = f.resubscribed + f.cancelled;
    return {
      ...c, volume, leads: leads.length, ...f,
      volumeToLead: volume ? leads.length / volume : null,
      leadToCustomer: leads.length ? f.converted_date / leads.length : null,
      resubRate: matured ? f.resubscribed / matured : null,
      planMrr: sum(leads.filter(l => l.facility_id && subsEnd.has(l.facility_id)).map(l => planMrr(data, subsEnd.get(l.facility_id)))),
    };
  });
  const customers = sum(rows.map(r => r.converted_date + r.wonBack)); // new paying facilities from leads
  return rows.map(r => ({ ...r, customers: r.converted_date + r.wonBack, conversionShare: customers ? (r.converted_date + r.wonBack) / customers : null }));
}

// ---------------- Marketing analytics (social + website) ----------------
/** Per-platform social totals for months a..b. Engagements = likes + comments + shares; rate = engagements / impressions. */
export function socialSummary(data, a, b) {
  return [...new Set(data.social_metrics.map(r => r.platform))].map(platform => {
    const rs = data.social_metrics.filter(r => r.platform === platform && inMonths(data, a, b)(r));
    const t = k => sum(rs.map(r => r[k]));
    const engagements = t('likes') + t('comments') + t('shares');
    return { platform, followers: rs.at(-1)?.followers ?? null, newFollowers: t('new_followers'), impressions: t('impressions'), likes: t('likes'), comments: t('comments'), shares: t('shares'), engagements, engagementRate: t('impressions') ? engagements / t('impressions') : null, linkClicks: t('link_clicks') };
  });
}
export const websiteTotals = (data, a, b) => {
  const rs = data.website_traffic.filter(inMonths(data, a, b));
  return { sessions: sum(rs.map(r => r.sessions)), pageViews: sum(rs.map(r => r.page_views)) };
};
