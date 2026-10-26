import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate, buildDashboardData, PLANS, N_MONTHS, monthOfIso } from '../scripts/generate.mjs';
import * as M from '../public/metrics.js';

const T = generate();
const D = buildDashboardData(T);
const byId = (rows, k) => new Map(rows.map(r => [r[k], r]));
const fac = byId(T.facilities, 'facility_id'), doc = byId(T.doctors, 'doctor_id'), nur = byId(T.nurses, 'nurse_id');
const pat = byId(T.patients, 'patient_id'), enc = byId(T.encounters, 'encounter_id'), loc = byId(T.locations, 'location_id');
const periodsOf = f => T.subscriptions.filter(s => s.facility_id === f).sort((a, b) => a.start_date.localeCompare(b.start_date));
const subscribedOn = (f, date) => periodsOf(f).some(s => s.start_date <= date && (s.end_date == null || date < s.end_date));

test('reproducible: same seed gives identical data', () => {
  assert.deepEqual(buildDashboardData(generate()), D);
});

test('24 consecutive months', () => {
  assert.equal(D.months.length, 24);
  D.months.forEach((m, i) => assert.equal(monthOfIso(m.key + '-01'), i + 1));
});

test('primary keys unique', () => {
  const pk = { facilities: 'facility_id', locations: 'location_id', doctors: 'doctor_id', nurses: 'nurse_id', patients: 'patient_id', subscriptions: 'subscription_id', subscription_addons: 'subscription_addon_id', encounters: 'encounter_id', appointments: 'appointment_id', clinical_notes: 'note_id', prescriptions: 'prescription_id', invoices: 'invoice_id', insurance_claims: 'claim_id', ai_transactions: 'ai_txn_id', token_purchases: 'purchase_id' };
  for (const [t, k] of Object.entries(pk)) assert.equal(new Set(T[t].map(r => r[k])).size, T[t].length, t);
});

test('subscription history is consistent per facility', () => {
  for (const f of fac.keys()) {
    const ps = periodsOf(f);
    assert.ok(ps.length >= 1, 'every facility has a subscription');
    ps.forEach((p, i) => {
      assert.ok(PLANS.some(x => x.plan_id === p.plan_id));
      if (i < ps.length - 1) { // contiguous, no overlap, only plan changes in between
        assert.equal(p.end_date, ps[i + 1].start_date);
        assert.ok(['upgrade', 'downgrade'].includes(p.end_reason));
      } else assert.ok(p.end_date == null || p.end_reason === 'cancelled', 'only the final period can be cancelled');
      if (p.end_date) assert.ok(p.end_date > p.start_date);
    });
    const plan0 = ps[0].plan_id, type = fac.get(f).facility_type;
    assert.equal(plan0 === 'BIRTHING_PRO', type === 'birthing_home');
  }
});

test('add-ons belong to subscribed facilities and stop at cancellation', () => {
  for (const a of T.subscription_addons) {
    assert.ok(fac.has(a.facility_id));
    assert.ok(subscribedOn(a.facility_id, a.start_date), a.subscription_addon_id);
    const last = periodsOf(a.facility_id).at(-1);
    if (last.end_reason === 'cancelled') assert.ok(a.end_date && a.end_date <= last.end_date);
    assert.ok(a.quantity > 0);
  }
});

test('encounters reference valid, same-facility entities within the service period', () => {
  for (const e of T.encounters) {
    assert.equal(pat.get(e.patient_id).facility_id, e.facility_id);
    assert.equal(doc.get(e.doctor_id).facility_id, e.facility_id);
    assert.ok(doc.get(e.doctor_id).start_date <= e.encounter_date);
    assert.equal(loc.get(e.location_id).facility_id, e.facility_id);
    if (e.nurse_id) assert.equal(nur.get(e.nurse_id).facility_id, e.facility_id);
    assert.ok(['OPD', 'IPD', 'ER', 'OTHER'].includes(e.category));
    const type = fac.get(e.facility_id).facility_type;
    if (e.category === 'ER') assert.ok(fac.get(e.facility_id).offers_er);
    assert.equal(e.maternity_service != null, type === 'birthing_home');
    const m = monthOfIso(e.encounter_date);
    assert.ok(m >= 1 && m <= N_MONTHS);
    assert.ok(subscribedOn(e.facility_id, e.encounter_date), `activity outside subscription: ${e.encounter_id}`);
    assert.ok(pat.get(e.patient_id).registered_date <= e.encounter_date);
  }
});

test('dependent records point at real encounters on the same date', () => {
  for (const [t, col] of [['clinical_notes', 'created_date'], ['prescriptions', 'created_date'], ['invoices', 'invoice_date'], ['insurance_claims', 'claim_date']])
    for (const r of T[t]) assert.equal(enc.get(r.encounter_id)?.encounter_date, r[col], t);
  for (const a of T.appointments) {
    assert.equal(pat.get(a.patient_id).facility_id, a.facility_id);
    assert.equal(a.status === 'completed', a.encounter_id != null);
    if (a.encounter_id) assert.equal(enc.get(a.encounter_id).patient_id, a.patient_id);
    assert.ok(subscribedOn(a.facility_id, a.scheduled_date));
  }
});

test('private claims only while the Private Insurance Claims add-on is active', () => {
  for (const c of T.insurance_claims.filter(c => c.payer_type === 'private')) {
    const e = enc.get(c.encounter_id);
    assert.ok(T.subscription_addons.some(a => a.facility_id === e.facility_id && a.addon_id === 'PRIVATE_CLAIMS' && a.start_date <= c.claim_date && (a.end_date == null || c.claim_date < a.end_date)));
  }
});

test('AI token consumption never exceeds tokens purchased', () => {
  for (const f of fac.keys()) {
    const ev = [...T.token_purchases.filter(p => p.facility_id === f).map(p => [p.purchase_date, 0, p.bundles * 50000]),
      ...T.ai_transactions.filter(t => t.facility_id === f).map(t => [t.txn_date, 1, -t.tokens])].sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]);
    let bal = 0; for (const [, , d] of ev) { bal += d; assert.ok(bal >= 0, f); }
  }
  for (const t of T.ai_transactions) assert.equal(enc.get(t.encounter_id).facility_id, t.facility_id);
});

test('aggregated usage rows match the raw records', () => {
  const s = f => D.usage.reduce((t, r) => t + r[f], 0);
  assert.equal(s('enc'), T.encounters.length);
  assert.equal(s('notes'), T.clinical_notes.length);
  assert.equal(s('rx'), T.prescriptions.length);
  assert.equal(s('appt_done') + s('appt_cancel') + s('appt_noshow'), T.appointments.length);
  assert.equal(s('ai_tokens'), T.ai_transactions.reduce((t, x) => t + x.tokens, 0));
  assert.ok(D.usage.every(r => r.rostered >= 1 && r.active_docs <= r.rostered));
});

test('subscribed facility counts are per facility, never per location', () => {
  for (const m of M.range(1, 24)) {
    const subs = M.subscribedAt(D, m);
    assert.ok(subs.size <= D.facilities.length);
    assert.ok(M.monthlyActive(D, m) <= D.usage.filter(r => r.m === m).length);
  }
  assert.ok(T.locations.length > T.facilities.length, 'some facilities have multiple branches');
});

test('MRR: hand-computed fixture (annual discount, facility discount, add-ons, tokens excluded)', () => {
  const fixture = {
    first_month: '2024-10', months: [{}, {}], assumptions: { annual_discount: 0.2 }, plans: PLANS,
    addons: [{ addon_id: 'STAFF', price: 448, recurring: true }, { addon_id: 'TOKEN', price: 336, recurring: false }],
    subscriptions: [
      { facility_id: 'A', plan_id: 'CLINIC_PRO', billing_cycle: 'monthly', discount_pct: 0.1, start_date: '2024-10-05', end_date: null, end_reason: null },
      { facility_id: 'B', plan_id: 'BIRTHING_PRO', billing_cycle: 'annual', discount_pct: 0, start_date: '2024-09-01', end_date: '2024-11-01', end_reason: 'cancelled' },
    ],
    subscription_addons: [
      { facility_id: 'A', addon_id: 'STAFF', quantity: 2, start_date: '2024-10-05', end_date: null },
      { facility_id: 'A', addon_id: 'TOKEN', quantity: 5, start_date: '2024-10-05', end_date: null },
    ],
  };
  assert.equal(M.mrrAt(fixture, 1).total, 3000 * 0.9 + 2 * 448 + 6999 * 0.8);
  assert.equal(M.mrrAt(fixture, 2).total, 3000 * 0.9 + 2 * 448); // B churned on Nov 1
  assert.deepEqual(M.churnRate(fixture, 2, 2), { churned: 1, base: 2, rate: 0.5 });
  assert.deepEqual(M.newFacilities(fixture, 1), ['A']);
});

test('forecast: anchored at last value, 6 months, uses only history, never negative', () => {
  const hist = M.range(1, 24).map(m => M.mrrAt(D, m).total);
  const fc = M.forecastMrr(hist);
  assert.equal(fc.length, 6);
  assert.deepEqual(fc.map(p => p.month), [25, 26, 27, 28, 29, 30]);
  assert.ok(Math.abs(fc[0].value - (hist[23] + fc[0].slope)) < 1e-6, 'continues from Month 24 value');
  assert.deepEqual(M.forecastMrr(hist.slice(0, 20)), M.forecastMrr([...hist.slice(0, 20)]), 'pure function of input');
  const declining = M.range(1, 24).map(i => 100000 - i * 9000);
  assert.ok(M.forecastMrr(declining).every(p => p.value >= 0 && p.low >= 0));
  const flat = Array(24).fill(50000);
  assert.ok(M.forecastMrr(flat).every(p => p.value === 50000 && p.low === 50000));
  fc.forEach(p => assert.ok(p.low <= p.value && p.value <= p.high));
});

test('backtest: trains on Months 1–20 only, forecasts 21–24 from Month 20, reports MAPE', () => {
  const hist = M.range(1, 24).map(m => M.mrrAt(D, m).total);
  const bt = M.backtestMrr(hist, 4, 12);
  assert.equal(bt.trainEnd, 20);
  assert.deepEqual(bt.forecast.map(p => p.month), [21, 22, 23, 24]);
  assert.deepEqual(bt.forecast, M.forecastMrr(hist.slice(0, 20), 4, 12), 'uses training months only');
  assert.ok(Math.abs(bt.forecast[0].value - (hist[19] + bt.forecast[0].slope)) < 1e-6, 'diverges from the Month 20 value');
  const mape = bt.forecast.reduce((t, p, i) => t + Math.abs(hist[20 + i] - p.value) / hist[20 + i], 0) / 4;
  assert.ok(Math.abs(bt.mape - mape) < 1e-12);
});

test('synthetic data contains the required mixed behaviours', () => {
  const churned = T.subscriptions.filter(s => s.end_reason === 'cancelled');
  assert.ok(churned.length >= 20, 'enough cancellations');
  assert.ok(T.subscriptions.some(s => s.end_reason === 'upgrade') && T.subscriptions.some(s => s.end_reason === 'downgrade'));
  assert.ok(T.subscriptions.some(s => s.billing_cycle === 'annual') && T.subscriptions.some(s => s.discount_pct > 0));
  const r = M.retainedVsChurned(D);
  assert.ok(r.churnedAboveMedianShare > 0.1, 'some high-usage facilities churn');
  const lowRetained = D.usage.filter(u => u.m === 24 && u.enc / u.rostered < 5).length;
  assert.ok(lowRetained > 0, 'some low-usage facilities stay subscribed');
});

test('lead funnel: ordered stages, no skipped stages, converted leads are exactly the acquired facilities', () => {
  const cols = ['engaged_date', 'inquired_date', 'demo_date', 'trial_start_date', 'converted_date'];
  const windowEnd = '2026-10-01';
  for (const l of T.leads) {
    for (let i = 1; i < cols.length; i++) {
      if (l[cols[i]] != null) { assert.ok(l[cols[i - 1]] != null, 'no skipped stage'); assert.ok(l[cols[i]] >= l[cols[i - 1]], 'stage dates ordered'); }
    }
    assert.ok(cols.every(c => l[c] == null || l[c] < windowEnd), 'no stage after the end of the data');
    assert.equal(l.outcome === 'converted', l.converted_date != null);
    assert.equal(l.outcome === 'won_back', l.resubscribed_date != null);
    if (l.resubscribed_date) { assert.ok(l.inquired_date && !l.converted_date); assert.ok(l.resubscribed_date > l.inquired_date && l.resubscribed_date < windowEnd); }
    if (l.trial_start_date && l.converted_date) assert.equal(Date.parse(l.converted_date) - Date.parse(l.trial_start_date), 14 * 864e5);
    assert.ok(['cold_calling', 'facebook', 'instagram', 'linkedin', 'website', 'referral'].includes(l.channel));
  }
  const converted = T.leads.filter(l => l.converted_date || l.resubscribed_date);
  assert.equal(new Set(converted.map(l => l.facility_id)).size, converted.length);
  for (const l of converted) assert.equal(periodsOf(l.facility_id)[0].start_date, l.converted_date ?? l.resubscribed_date, 'subscription starts on conversion / win-back');
  assert.equal(T.leads.filter(l => l.facility_id && !l.converted_date && !l.resubscribed_date).length, 0);
  assert.equal(T.facilities.length - converted.length, 45, 'only the pre-window base lacks a lead');
});

test('funnel metrics: Sankey conserves flow and matches stage counts', () => {
  const { flows, total } = M.funnelSankey(D, 1, 24);
  const inflow = n => flows.filter(f => f.to === n).reduce((t, f) => t + f.flow, 0);
  const outflow = n => flows.filter(f => f.from === n).reduce((t, f) => t + f.flow, 0);
  const leads = M.leadsIn(D, 1, 24), f0 = M.funnelCounts(D, leads);
  const STAGE_NODES = [['engaged_date', 'Engaged'], ['inquired_date', 'Inquired'], ['demo_date', 'Demo'], ['trial_start_date', 'Free trial'], ['converted_date', 'Converted']];
  const openAt = col => leads.filter(l => l.outcome === 'open' && [...STAGE_NODES].reverse().find(([c]) => l[c] != null)[0] === col).length;
  assert.equal(inflow('Engaged'), total);
  for (const [col, n] of STAGE_NODES) assert.equal(n === 'Engaged' ? total : inflow(n), outflow(n) + openAt(col) + (n === 'Converted' ? f0.tooRecent : 0), n);
  assert.equal(inflow('Re-subscribed'), f0.resubscribed + f0.wonBack);
  const f = M.funnelCounts(D, M.leadsIn(D, 1, 24));
  assert.equal(inflow('Converted'), f.converted_date);
  assert.equal(f.resubscribed + f.cancelled + f.tooRecent, f.converted_date);
});

test('marketing analytics: 24 months per platform/source, social clicks feed website sessions', () => {
  assert.equal(D.social_metrics.length, 24 * 3);
  assert.equal(D.website_traffic.length, 24 * 4);
  assert.equal(D.outbound_calls.length, 24);
  for (const r of D.social_metrics) {
    assert.ok(r.likes >= 0 && r.comments >= 0 && r.shares >= 0 && r.impressions > r.likes);
    const sessions = D.website_traffic.find(w => w.month === r.month && w.source === r.platform).sessions;
    assert.ok(sessions <= r.link_clicks * 1.2, 'sessions from a platform come from its link clicks');
  }
});

test('channel mix: cold calling converts the most, Facebook gets the most engagement', () => {
  const conv = Object.fromEntries(M.channelSummary(D, 1, 24).map(c => [c.channel, c.customers]));
  assert.equal(Object.entries(conv).sort((x, y) => y[1] - x[1])[0][0], 'cold_calling');
  const eng = M.socialSummary(D, 1, 24).sort((x, y) => y.engagements - x.engagements);
  assert.equal(eng[0].platform, 'facebook');
});
