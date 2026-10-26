// Synthetic SugboDoc dataset generator. ALL DATA IS SYNTHETIC — no real facilities, patients or billing.
//
// Generative structure: each facility first gets hidden latent traits (size, adoption propensity,
// activity level, consistency, ramp speed, instability, perceived value, retention tendency,
// price sensitivity, growth). Those traits drive the observable records (staff, patients,
// encounters, module usage, subscriptions, cancellations). Latent traits are NOT written out.
//
// DESIGN ASSUMPTION (documented, see README): churn hazard depends on the latent "perceived value"
// (which also drives how much of the facility's work is captured in SugboDoc) and on temporary
// operational shocks (which also depress activity). Any engagement/churn association the dashboard
// shows is therefore built in through these shared causes; the cancellation outcome itself is never
// used to shape engagement. A usage-independent closure hazard produces high-usage churners.
//
// ACQUISITION: new facilities come from a simulated lead funnel (cold calls, social, website, referrals -> engaged ->
// inquired -> demo -> 14-day free trial -> converted). Each converted lead IS a facility; its
// subscription starts on the conversion date. The pre-window base (45 facilities) has no lead record;
// Month-0 warm-up leads may convert just before Month 1.
//
// Run: node scripts/generate.mjs   (seeded, fully reproducible)

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const SEED = 20241001;
export const FIRST_MONTH = '2024-10'; // Month 1. Month 24 = 2026-09 (last complete month).
export const N_MONTHS = 24;
export const ANNUAL_DISCOUNT = 0.2;      // "annual packages save 20%" (reported, unverified)
export const TOKENS_PER_BUNDLE = 50000;  // ASSUMPTION: bundle size is not published

// List prices are reference prices, not verified billing records.
export const PLANS = [
  { plan_id: 'CLINIC_STARTER', name: 'Clinic Starter', list_price: 999, max_doctors: 1, max_midwives: 0, max_locations: 4 },
  { plan_id: 'CLINIC_PRO', name: 'Clinic Pro', list_price: 3000, max_doctors: 4, max_midwives: 0, max_locations: 4 },
  { plan_id: 'BIRTHING_PRO', name: 'Birthing Home Pro', list_price: 6999, max_doctors: 4, max_midwives: 4, max_locations: 1 },
];
// ASSUMPTION: recurring add-ons bill monthly at list price (no annual discount). Tokens are
// one-time purchases with no confirmed interval -> non-recurring, excluded from MRR.
export const ADDONS = [
  { addon_id: 'STAFF', name: 'Staff', price: 448, recurring: true },
  { addon_id: 'PRIVATE_CLAIMS', name: 'Private Insurance Claims', price: 600, recurring: true },
  { addon_id: 'ADD_FEATURES', name: 'Add Features', price: 560, recurring: true },
  { addon_id: 'STORAGE', name: 'Storage Capacity', price: 399, recurring: true },
  { addon_id: 'BRANCHES', name: 'Add Branches', price: 448, recurring: true },
  { addon_id: 'IMAGING_STORAGE', name: 'Imaging Storage Capacity', price: 699, recurring: true },
  { addon_id: 'TOKEN', name: 'SugboDoc Token', price: 336, recurring: false },
];
export const MODULES = ['encounters', 'clinical_notes', 'prescriptions', 'appointments', 'invoicing', 'insurance_claims', 'ai_assist'];
// ASSUMPTIONS (marketing): all volumes and rates are illustrative, not SugboDoc figures. No ad-spend data -> no CAC.
// Funnel sources. Top-of-funnel volume per month: site sessions from that source (digital), calls made
// (cold calling) or referrals received (referral). `engage` = share of that volume that becomes an engaged
// lead (identifiable facility prospect). Stage probabilities follow. Each lead has one source channel.
export const CHANNELS = [
  { channel: 'cold_calling', name: 'Cold calling', volume_unit: 'calls made', engage: 0.02, inquire: 0.5, demo: 0.6, trial: 0.6, convert: 0.5 },
  { channel: 'facebook', name: 'Facebook', volume_unit: 'site sessions', engage: 0.013, inquire: 0.21, demo: 0.5, trial: 0.55, convert: 0.4 },
  { channel: 'instagram', name: 'Instagram', volume_unit: 'site sessions', engage: 0.013, inquire: 0.16, demo: 0.45, trial: 0.5, convert: 0.35 },
  { channel: 'linkedin', name: 'LinkedIn', volume_unit: 'site sessions', engage: 0.014, inquire: 0.34, demo: 0.6, trial: 0.62, convert: 0.5 },
  { channel: 'website', name: 'Website (organic/direct)', volume_unit: 'site sessions', engage: 0.0064, inquire: 0.29, demo: 0.55, trial: 0.6, convert: 0.45 },
  { channel: 'referral', name: 'Referral', volume_unit: 'referrals received', engage: 1, inquire: 0.7, demo: 0.7, trial: 0.7, convert: 0.6 },
];
// Social platforms (marketing analytics). Month-0 baselines; Facebook has the largest audience and engagement.
// Rates are per impression. Link clicks land on the website (85% become sessions).
export const SOCIAL = [
  { platform: 'facebook', followers0: 12000, impressions0: 60000, growth: 0.02, like: 0.045, comment: 0.006, share: 0.004, click: 0.014, follow: 0.002 },
  { platform: 'instagram', followers0: 6500, impressions0: 42000, growth: 0.03, like: 0.035, comment: 0.003, share: 0.0015, click: 0.012, follow: 0.003 },
  { platform: 'linkedin', followers0: 3000, impressions0: 15000, growth: 0.025, like: 0.02, comment: 0.002, share: 0.0015, click: 0.02, follow: 0.0025 },
];
const ORGANIC_SESSIONS0 = 1500, CALLS0 = 480, REFERRALS0 = 1.45;
export const TRIAL_DAYS = 14; // ASSUMPTION
// Win-back: a lead that dropped after inquiring may come back 1–5 months later and subscribe ('won_back').
// Probability by the stage it dropped at (ASSUMPTION): no demo, no trial, not converted after trial.
const WINBACK = { demo_date: 0.1, trial_start_date: 0.15, converted_date: 0.25 };
const OPTIONAL_MODULES = { prescriptions: 0.18, appointments: 0.1, invoicing: 0.12, insurance_claims: 0.07, ai_assist: 0.05 };

// ---- date helpers (UTC day numbers; months indexed so that Month 1 = FIRST_MONTH) ----
const [Y0, M0] = FIRST_MONTH.split('-').map(Number);
export const monthStart = i => Date.UTC(Y0, M0 - 1 + i - 1, 1) / 864e5;
export const iso = day => new Date(day * 864e5).toISOString().slice(0, 10);
export const monthOfIso = s => (Number(s.slice(0, 4)) - Y0) * 12 + Number(s.slice(5, 7)) - M0 + 1;

function mulberry32(a) {
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

export function generate(seed = SEED) {
  const rand = mulberry32(seed);
  const normal = (mu = 0, sd = 1) => mu + sd * Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const chance = p => rand() < p;
  const pick = arr => arr[Math.floor(rand() * arr.length)];
  const weighted = pairs => { let r = rand(); for (const [v, w] of pairs) { if ((r -= w) < 0) return v; } return pairs.at(-1)[0]; };
  const poisson = l => { if (l <= 0) return 0; const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= rand(); } while (p > L); return k - 1; };

  const T = {
    facilities: [], locations: [], doctors: [], nurses: [], patients: [], subscriptions: [], subscription_addons: [],
    encounters: [], appointments: [], clinical_notes: [], prescriptions: [], invoices: [], insurance_claims: [],
    ai_transactions: [], token_purchases: [], social_metrics: [], website_traffic: [], outbound_calls: [], leads: [],
  };
  const ids = {};
  const nextId = (prefix) => `${prefix}-${String(ids[prefix] = (ids[prefix] || 0) + 1).padStart(6, '0')}`;
  const planById = Object.fromEntries(PLANS.map(p => [p.plan_id, p]));

  // ---- Lead funnel. Month 0 is a warm-up so Month 1 conversions aren't artificially low. ----
  const WINDOW_END = monthStart(N_MONTHS + 1); // stage dates on/after this are not observed yet
  const starts = []; // { day, lead }
  const followers = {};
  for (let m = 0; m <= N_MONTHS; m++) {
    const mStart = monthStart(m), days = monthStart(m + 1) - mStart;
    const season = 1 + 0.08 * Math.sin(2 * Math.PI * (m + 3) / 12);
    const month = iso(mStart).slice(0, 7), noise = sd => Math.exp(normal(0, sd));
    const volume = {}; // top-of-funnel volume per channel this month
    for (const p of SOCIAL) {
      const impressions = Math.round(p.impressions0 * (1 + p.growth) ** m * season * noise(0.12));
      const new_followers = Math.round(impressions * p.follow * noise(0.2));
      followers[p.platform] = (followers[p.platform] ?? p.followers0) + new_followers;
      const link_clicks = Math.round(impressions * p.click * noise(0.15));
      T.social_metrics.push({ month, platform: p.platform, followers: followers[p.platform], new_followers, impressions,
        likes: Math.round(impressions * p.like * noise(0.15)), comments: Math.round(impressions * p.comment * noise(0.2)), shares: Math.round(impressions * p.share * noise(0.25)), link_clicks });
      volume[p.platform] = Math.round(link_clicks * 0.85 * noise(0.05));
    }
    volume.website = Math.round(ORGANIC_SESSIONS0 * 1.02 ** m * season * noise(0.1));
    for (const source of ['website', 'facebook', 'instagram', 'linkedin']) T.website_traffic.push({ month, source: source === 'website' ? 'organic_direct' : source, sessions: volume[source], page_views: Math.round(volume[source] * (2.1 + rand() * 0.6)) });
    volume.cold_calling = Math.round(CALLS0 * 1.015 ** m * noise(0.1));
    T.outbound_calls.push({ month, calls_made: volume.cold_calling });
    volume.referral = REFERRALS0 * 1.03 ** m; // expected referrals; realised count = referral leads
    for (const c of CHANNELS) {
      for (let k = poisson(volume[c.channel] * c.engage); k > 0; k--) {
        const lead = { lead_id: nextId('LEAD'), channel: c.channel, engaged_date: mStart + Math.floor(rand() * days), inquired_date: null, demo_date: null, trial_start_date: null, converted_date: null, resubscribed_date: null, outcome: 'lost', facility_id: null };
        const quality = Math.exp(normal(0, 0.3)); // lead-level noise shared across stages
        const steps = [['inquired_date', c.inquire, 1 + poisson(4)], ['demo_date', c.demo, 2 + poisson(6)], ['trial_start_date', c.trial, poisson(3)], ['converted_date', c.convert, TRIAL_DAYS]];
        let day = lead.engaged_date;
        for (const [col, p, lag] of steps) {
          if (!chance(Math.min(0.95, p * quality))) {          // dropped at this stage
            const back = day + 30 + Math.floor(rand() * 120);
            if (WINBACK[col] && chance(WINBACK[col] * quality) && back < WINDOW_END) { lead.resubscribed_date = back; lead.outcome = 'won_back'; starts.push({ day: back, lead }); }
            break;
          }
          day += lag;
          if (day >= WINDOW_END) { lead.outcome = 'open'; break; } // next stage not reached yet
          lead[col] = day;
          if (col === 'converted_date') { lead.outcome = 'converted'; starts.push({ day, lead }); }
        }
        for (const col of ['engaged_date', 'inquired_date', 'demo_date', 'trial_start_date', 'converted_date', 'resubscribed_date']) if (lead[col] != null) lead[col] = iso(lead[col]);
        T.leads.push(lead);
      }
    }
  }
  // Existing base: onboarded up to 18 months before Month 1 (no lead records).
  for (let i = 0; i < 45; i++) { const m = -17 + Math.floor(rand() * 18); starts.push({ day: monthStart(m) + Math.floor(rand() * 28), lead: null }); }
  starts.sort((a, b) => a.day - b.day);

  for (const { day: startDay, lead } of starts) {
    const fid = nextId('FAC');
    if (lead) lead.facility_id = fid;
    const startMonth = monthOfIso(iso(startDay));
    const type = chance(0.2) ? 'birthing_home' : 'clinic';

    // ---- latent traits (hidden) ----
    const size = Math.exp(normal(0, 0.5));
    const adoption = clamp(normal(0.55, 0.2), 0.05, 0.98);
    const consistency = clamp(normal(0.72, 0.18), 0.15, 0.98);
    const activity = Math.exp(normal(0, 0.35));
    const rampMonths = 1 + rand() * 5;
    const instability = clamp(normal(0.025, 0.02), 0, 0.09);
    const valueBase = clamp(0.25 + 0.5 * adoption + normal(0, 0.12), 0.05, 0.95);
    const valueDrift = normal(0, 0.02);   // some facilities improve, some slowly disengage
    const retention = Math.exp(normal(0, 0.55)); // hazard multiplier
    const priceSensitivity = rand();
    const growth = clamp(normal(0.012, 0.01), 0, 0.04);

    // ---- observable structure ----
    const offersEr = type === 'clinic' && size > 1.3 && chance(0.35);
    T.facilities.push({ facility_id: fid, facility_type: type, offers_er: offersEr });

    const nLoc = type === 'clinic' ? weighted([[1, 0.7], [2, 0.2], [3, 0.07], [4, 0.03]]) : weighted([[1, 0.88], [2, 0.12]]);
    const locs = [];
    for (let i = 0; i < nLoc; i++) { const id = nextId('LOC'); locs.push(id); T.locations.push({ location_id: id, facility_id: fid, is_primary: i === 0, opened_date: iso(startDay) }); }

    const doctors = []; // {id, start}
    const addDoctor = day => { const d = { id: nextId('DOC'), start: day }; doctors.push(d); T.doctors.push({ doctor_id: d.id, facility_id: fid, start_date: iso(day) }); return d; };
    const nDoc0 = type === 'clinic'
      ? (chance(0.5) ? 1 : clamp(Math.round(1 + size * 1.5 + normal(0, 0.7)), 2, 6))
      : clamp(Math.round(1 + size * 1.1 + normal(0, 0.5)), 1, 4);
    for (let i = 0; i < nDoc0; i++) addDoctor(startDay);

    // Nurses (clinic) / midwives (birthing home). Doctor assignment may be null.
    const nurses = [];
    const nNurse = type === 'clinic' ? poisson(nDoc0 * 0.7) : clamp(Math.round(1 + size * 2 + normal(0, 0.6)), 1, 5);
    for (let i = 0; i < nNurse; i++) {
      const n = { id: nextId('NUR'), doctor: chance(0.6) ? pick(doctors).id : null };
      nurses.push(n);
      T.nurses.push({ nurse_id: n.id, facility_id: fid, role: type === 'clinic' ? 'nurse' : 'midwife', assigned_doctor_id: n.doctor, start_date: iso(startDay) });
    }
    const midwives = type === 'birthing_home' ? nurses.length : 0;

    // ---- subscription state ----
    let plan = type === 'birthing_home' ? 'BIRTHING_PRO' : (nDoc0 === 1 && chance(0.75) ? 'CLINIC_STARTER' : 'CLINIC_PRO');
    const cycle = chance(0.2 + (type === 'birthing_home' ? 0.15 : 0) + (nDoc0 >= 3 ? 0.1 : 0)) ? 'annual' : 'monthly';
    const discount = cycle === 'annual' ? weighted([[0, 0.85], [0.1, 0.15]]) : weighted([[0, 0.7], [0.1, 0.2], [0.15, 0.1]]);
    let period = null, termEnd = null;
    const openPeriod = (day, m) => {
      period = { subscription_id: nextId('SUB'), facility_id: fid, plan_id: plan, billing_cycle: cycle, discount_pct: discount, start_date: iso(day), end_date: null, end_reason: null };
      T.subscriptions.push(period);
      termEnd = cycle === 'annual' ? m + 12 : null;
    };
    const closePeriod = (day, reason) => { period.end_date = iso(day); period.end_reason = reason; };
    openPeriod(startDay, startMonth);

    const addons = {}; // addon_id -> row
    const setAddon = (addonId, qty, day) => {
      const cur = addons[addonId];
      if ((cur?.quantity || 0) === qty) return;
      if (cur) cur.end_date = iso(day);
      delete addons[addonId];
      if (qty > 0) { addons[addonId] = { subscription_addon_id: nextId('ADD'), facility_id: fid, addon_id: addonId, quantity: qty, start_date: iso(day), end_date: null }; T.subscription_addons.push(addons[addonId]); }
    };
    const syncCapacity = day => {
      const p = planById[plan];
      setAddon('STAFF', Math.max(0, doctors.length - p.max_doctors) + Math.max(0, midwives - p.max_midwives), day);
      setAddon('BRANCHES', Math.max(0, nLoc - p.max_locations), day);
    };
    syncCapacity(startDay);
    if (chance(0.12 + (nDoc0 >= 3 ? 0.15 : 0))) setAddon('PRIVATE_CLAIMS', 1, startDay);
    if (chance(0.1 + 0.2 * adoption)) setAddon('ADD_FEATURES', 1, startDay);
    if (chance(0.08 + 0.08 * size)) setAddon('STORAGE', 1, startDay);
    if (chance(type === 'birthing_home' ? 0.2 : 0.04)) setAddon('IMAGING_STORAGE', 1, startDay);

    // ---- activity state ----
    const adopted = { encounters: startMonth, clinical_notes: startMonth };
    let value = valueBase, shockLeft = 0, shockMult = 1, tokenBalance = 0;
    const pool = []; // patient ids
    const firstActiveMonth = Math.max(1, startMonth);

    for (let m = firstActiveMonth; m <= N_MONTHS; m++) {
      const mStart = monthStart(m), mEnd = monthStart(m + 1);
      const from = Math.max(mStart, startDay); // first service day this month
      const randomDay = () => from + Math.floor(rand() * (mEnd - from));
      const tenure = m - startMonth;

      // 1) Decisions effective on the 1st of the month (based on last month's latent state).
      if (m > startMonth && m > 1) {
        const misfit = plan === 'CLINIC_PRO' && doctors.length === 1;
        let h = 0.016 * retention * Math.exp(3 * (0.5 - value)) * (shockLeft > 0 ? 2.5 : 1) * (misfit ? 1.5 : 1)
          * (1 + 0.6 * priceSensitivity * (discount === 0)) * (tenure < 4 ? 1.4 : 1);
        h = Math.min(h, 0.3) + 0.003; // + closure / commercial reasons unrelated to usage
        const canCancel = cycle === 'monthly' || m === termEnd;
        const pCancel = cycle === 'monthly' ? h : 1 - (1 - 0.6 * h) ** 12;
        if (canCancel && chance(pCancel)) {
          closePeriod(mStart, 'cancelled');
          for (const a of Object.values(addons)) a.end_date = iso(mStart);
          break;
        }
        if (m === termEnd) termEnd += 12; // annual renewal
        if (misfit && value < 0.45 && chance(0.05)) { closePeriod(mStart, 'downgrade'); plan = 'CLINIC_STARTER'; openPeriod(mStart, m); syncCapacity(mStart); }
        else if (plan === 'CLINIC_STARTER' && value > 0.7 && chance(0.012)) { closePeriod(mStart, 'upgrade'); plan = 'CLINIC_PRO'; openPeriod(mStart, m); syncCapacity(mStart); }
      }

      // 2) Latent evolution.
      value = clamp(value + valueDrift + 0.03 * (valueBase - value) + normal(0, 0.035), 0.02, 0.98);
      if (shockLeft > 0) shockLeft--; else if (chance(instability)) { shockLeft = 2 + Math.floor(rand() * 4); shockMult = 0.05 + rand() * 0.45; }
      const inShock = shockLeft > 0;
      const ramp = 1 - Math.exp(-(tenure + 1) / rampMonths);

      // 3) Growth: new doctor -> upgrade (Starter) or Staff add-on (at capacity).
      if (chance(growth) && doctors.length < 8) {
        const day = randomDay();
        addDoctor(day);
        if (plan === 'CLINIC_STARTER') { closePeriod(day, 'upgrade'); plan = 'CLINIC_PRO'; openPeriod(day, m); }
        syncCapacity(day);
      }
      for (const a of ['PRIVATE_CLAIMS', 'ADD_FEATURES', 'STORAGE']) if (!addons[a] && chance(0.005 * value)) setAddon(a, 1, randomDay());

      // 4) Module adoption.
      for (const [mod, base] of Object.entries(OPTIONAL_MODULES)) {
        if (adopted[mod] == null && chance(base * (adoption + value) / 2 * (inShock ? 0.3 : 1))) adopted[mod] = m;
      }

      // 5) Daily activity.
      const capture = 0.3 + 0.7 * value;
      const pUse = clamp(consistency * (0.3 + 0.7 * value) * (inShock ? 0.35 : 1) * (0.6 + 0.4 * ramp), 0.01, 0.99);
      for (let day = from; day < mEnd; day++) {
        const dow = (day + 4) % 7; // 0 = Sunday
        if (dow === 0 && type === 'clinic') continue;
        if (!chance(pUse * (dow === 0 ? 0.4 : 1))) continue;
        const date = iso(day);
        for (const doc of doctors) {
          if (doc.start > day) continue;
          const n = poisson(2.6 * activity * capture * ramp * (inShock ? shockMult : 1));
          for (let k = 0; k < n; k++) {
            let patient;
            if (pool.length && chance(0.6)) patient = pick(pool);
            else {
              patient = nextId('PAT'); pool.push(patient);
              T.patients.push({ patient_id: patient, facility_id: fid, sex: type === 'birthing_home' ? (chance(0.95) ? 'F' : 'M') : (chance(0.55) ? 'F' : 'M'), birth_year: 2026 - clamp(Math.round(normal(type === 'birthing_home' ? 27 : 38, type === 'birthing_home' ? 6 : 20)), 0, 95), registered_date: date });
            }
            const eligibleNurses = nurses.filter(x => x.doctor === doc.id || x.doctor === null);
            const nurse = eligibleNurses.length && chance(0.45) ? pick(eligibleNurses).id : null;
            let category, service = null;
            if (type === 'birthing_home') {
              service = weighted([['prenatal', 0.5], ['postnatal', 0.2], ['delivery', 0.12], ['general', 0.18]]);
              category = service === 'delivery' ? 'IPD' : 'OPD';
            } else {
              category = offersEr && chance(0.06) ? 'ER' : chance(0.04) ? 'OTHER' : 'OPD';
            }
            const eid = nextId('ENC');
            T.encounters.push({ encounter_id: eid, facility_id: fid, location_id: pick(locs), patient_id: patient, doctor_id: doc.id, nurse_id: nurse, encounter_date: date, category, maternity_service: service });

            if (chance(0.4 + 0.55 * value)) T.clinical_notes.push({ note_id: nextId('NOTE'), encounter_id: eid, created_date: date });
            if (adopted.prescriptions != null && category !== 'IPD' && chance(0.55)) T.prescriptions.push({ prescription_id: nextId('RX'), encounter_id: eid, created_date: date, item_count: 1 + poisson(1) });
            if (adopted.appointments != null && category === 'OPD' && chance(0.55)) {
              T.appointments.push({ appointment_id: nextId('APT'), facility_id: fid, patient_id: patient, doctor_id: doc.id, scheduled_date: date, status: 'completed', encounter_id: eid });
              const extra = chance(0.09) ? 'cancelled' : chance(0.08) ? 'no_show' : null;
              if (extra) T.appointments.push({ appointment_id: nextId('APT'), facility_id: fid, patient_id: pick(pool), doctor_id: doc.id, scheduled_date: date, status: extra, encounter_id: null });
            }
            if (adopted.invoicing != null && chance(0.85)) T.invoices.push({ invoice_id: nextId('INV'), encounter_id: eid, invoice_date: date, amount: Math.round((category === 'IPD' ? 9000 : category === 'ER' ? 1500 : 500) * Math.exp(normal(0, 0.3))) });
            if (adopted.insurance_claims != null && chance(category === 'IPD' ? 0.8 : 0.12)) T.insurance_claims.push({ claim_id: nextId('CLM'), encounter_id: eid, claim_date: date, payer_type: 'philhealth' });
            if (addons.PRIVATE_CLAIMS && iso(day) >= addons.PRIVATE_CLAIMS.start_date && chance(0.1)) T.insurance_claims.push({ claim_id: nextId('CLM'), encounter_id: eid, claim_date: date, payer_type: 'private' });
            if (adopted.ai_assist != null && chance(0.12 + 0.3 * value)) {
              const tokens = Math.round(Math.exp(normal(7.2, 0.5)));
              if (tokenBalance < tokens) {
                const bundles = 1 + (chance(0.3) ? 1 : 0);
                tokenBalance += bundles * TOKENS_PER_BUNDLE;
                T.token_purchases.push({ purchase_id: nextId('TOK'), facility_id: fid, purchase_date: date, bundles, unit_price: 336, amount: bundles * 336 });
              }
              tokenBalance -= tokens;
              T.ai_transactions.push({ ai_txn_id: nextId('AI'), facility_id: fid, doctor_id: doc.id, encounter_id: eid, txn_date: date, feature: pick(['note_drafting', 'visit_summary', 'referral_letter']), tokens });
            }
          }
        }
      }
    }
  }
  return T;
}

// ---------- Derive the compact dashboard dataset from the relational records ----------
// Every number here is aggregated from the raw tables above (nothing stored twice at source).
export function buildDashboardData(T) {
  const nextMonthIso = m => iso(monthStart(m + 1));
  const months = [];
  for (let m = 1; m <= N_MONTHS; m++) months.push({ index: m, key: iso(monthStart(m)).slice(0, 7) });

  // Facility-months with a subscription at any point in the month get a usage row (zeros are real zeros).
  const rows = new Map();
  const key = (f, m) => `${f}|${m}`;
  for (const s of T.subscriptions) {
    const a = Math.max(1, monthOfIso(s.start_date));
    const b = s.end_date ? monthOfIso(s.end_date) - (s.end_date.endsWith('-01') ? 1 : 0) : N_MONTHS;
    for (let m = a; m <= Math.min(b, N_MONTHS); m++) {
      if (!rows.has(key(s.facility_id, m))) rows.set(key(s.facility_id, m), {
        f: s.facility_id, m, enc: 0, opd: 0, ipd: 0, er: 0, other: 0, patients: new Set(), docs: new Set(), days: new Set(),
        rostered: 0, notes: 0, rx: 0, appt_done: 0, appt_cancel: 0, appt_noshow: 0, invoices: 0, claims: 0, ai_tx: 0, ai_tokens: 0, token_rev: 0, mods: new Set(),
      });
    }
  }
  const row = (f, date) => rows.get(key(f, monthOfIso(date)));
  const encById = new Map();
  for (const e of T.encounters) {
    encById.set(e.encounter_id, e);
    const r = row(e.facility_id, e.encounter_date);
    r.enc++; r[e.category.toLowerCase()]++; r.patients.add(e.patient_id); r.docs.add(e.doctor_id); r.days.add(e.encounter_date); r.mods.add('encounters');
  }
  const viaEnc = (tbl, dateCol, fn) => { for (const x of tbl) { const e = encById.get(x.encounter_id); fn(row(e.facility_id, x[dateCol]), x); } };
  viaEnc(T.clinical_notes, 'created_date', r => { r.notes++; r.mods.add('clinical_notes'); });
  viaEnc(T.prescriptions, 'created_date', r => { r.rx++; r.mods.add('prescriptions'); });
  viaEnc(T.invoices, 'invoice_date', r => { r.invoices++; r.mods.add('invoicing'); });
  viaEnc(T.insurance_claims, 'claim_date', r => { r.claims++; r.mods.add('insurance_claims'); });
  for (const a of T.appointments) {
    const r = row(a.facility_id, a.scheduled_date); r.mods.add('appointments');
    if (a.status === 'completed') r.appt_done++; else if (a.status === 'cancelled') r.appt_cancel++; else r.appt_noshow++;
  }
  for (const t of T.ai_transactions) { const r = row(t.facility_id, t.txn_date); r.ai_tx++; r.ai_tokens += t.tokens; r.mods.add('ai_assist'); }
  for (const p of T.token_purchases) row(p.facility_id, p.purchase_date).token_rev += p.amount;
  for (const r of rows.values()) r.rostered = T.doctors.filter(d => d.facility_id === r.f && d.start_date < nextMonthIso(r.m)).length;

  const usage = [...rows.values()].map(r => ({
    ...r, patients: r.patients.size, active_docs: r.docs.size, active_days: r.days.size,
    modules: MODULES.filter(x => r.mods.has(x)), docs: undefined, days: undefined, mods: undefined,
  })).sort((a, b) => a.m - b.m || a.f.localeCompare(b.f));

  const strip = ({ subscription_id, ...s }) => s;
  const inWindow = r => r.month >= FIRST_MONTH;
  return {
    note: 'SYNTHETIC DATA — generated for demonstration; does not represent actual SugboDoc customers.',
    generated_with_seed: SEED,
    first_month: FIRST_MONTH,
    months,
    assumptions: { annual_discount: ANNUAL_DISCOUNT, tokens_per_bundle: TOKENS_PER_BUNDLE },
    plans: PLANS, addons: ADDONS, modules: MODULES,
    facilities: T.facilities.map(f => ({ ...f, locations: T.locations.filter(l => l.facility_id === f.facility_id).length })),
    subscriptions: T.subscriptions.map(strip),
    subscription_addons: T.subscription_addons.map(({ subscription_addon_id, ...a }) => a),
    usage,
    channels: CHANNELS.map(({ channel, name, volume_unit }) => ({ channel, name, volume_unit })),
    trial_days: TRIAL_DAYS,
    social_metrics: T.social_metrics.filter(inWindow),
    website_traffic: T.website_traffic.filter(inWindow),
    outbound_calls: T.outbound_calls.filter(inWindow),
    leads: T.leads.map(({ lead_id, ...l }) => l),
  };
}

const toCsv = rows => {
  const cols = Object.keys(rows[0]);
  const esc = v => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n') + '\n';
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const T = generate();
  mkdirSync(join(root, 'data', 'raw'), { recursive: true });
  for (const [name, rows] of Object.entries(T)) writeFileSync(join(root, 'data', 'raw', `${name}.csv`), toCsv(rows));
  writeFileSync(join(root, 'data', 'raw', 'plans.csv'), toCsv(PLANS));
  writeFileSync(join(root, 'data', 'raw', 'addons.csv'), toCsv(ADDONS));
  writeFileSync(join(root, 'data', 'raw', 'channels.csv'), toCsv(CHANNELS));
  writeFileSync(join(root, 'data', 'raw', 'social_platforms.csv'), toCsv(SOCIAL));
  mkdirSync(join(root, 'public', 'data'), { recursive: true });
  writeFileSync(join(root, 'public', 'data', 'dashboard.json'), JSON.stringify(buildDashboardData(T)));
  console.log(Object.entries(T).map(([k, v]) => `${k}: ${v.length}`).join('\n'));
}
