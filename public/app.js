import * as M from './metrics.js';

const data = await (await fetch('data/dashboard.json')).json();
const N = data.months.length;
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const C = { s1: css('--s1'), s2: css('--s2'), s3: css('--s3'), s4: css('--s4'), neutral: css('--neutral'), text2: css('--text-2'), muted: css('--muted'), grid: css('--grid'), highlight: css('--highlight'), forecastBg: css('--forecast-bg'), card: css('--card') };
const PLAN_COLOR = { CLINIC_STARTER: C.s1, CLINIC_PRO: C.s2, BIRTHING_PRO: C.s3 };

const peso = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', maximumFractionDigits: 0 });
const pesoShort = v => v >= 1e6 ? `₱${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `₱${Math.round(v / 1e3)}k` : `₱${Math.round(v)}`;
const int = new Intl.NumberFormat('en-PH');
const pct = (v, d = 1) => v == null ? 'n/a' : `${(v * 100).toFixed(d)}%`;
const num = (v, d = 1) => v == null ? 'n/a' : v.toFixed(d);
const monthLabel = i => new Date(M.monthIso(data, i) + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const MODULE_LABEL = { encounters: 'Encounters', clinical_notes: 'Clinical notes', prescriptions: 'e-Prescriptions', appointments: 'Appointments', invoicing: 'Invoicing', insurance_claims: 'Insurance claims', ai_assist: 'AI assist (tokens)' };
const $ = id => document.getElementById(id);

Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
Chart.defaults.font.size = 11.5;
Chart.defaults.color = C.text2;
Chart.defaults.borderColor = C.grid;
Chart.defaults.maintainAspectRatio = false;
Chart.defaults.plugins.legend.labels.boxWidth = 10;
Chart.defaults.plugins.legend.labels.boxHeight = 10;
Chart.defaults.plugins.tooltip.mode = 'index';
Chart.defaults.plugins.tooltip.intersect = false;
Chart.defaults.elements.line.borderWidth = 2;
Chart.defaults.elements.point.radius = 0;
Chart.defaults.elements.point.hoverRadius = 4;
Chart.defaults.elements.bar.borderRadius = 3;
Chart.defaults.datasets.bar.maxBarThickness = 36;

const charts = {};
const draw = (id, config) => { charts[id]?.destroy(); charts[id] = new Chart($(id), config); };
const axisTitle = text => ({ display: true, text, color: C.muted });

// ---------- Static: MRR + forecast (full history always; forecast from all observed months) ----------
function drawMrr() {
  const hist = M.range(1, N).map(m => M.mrrAt(data, m).total);
  const fc = M.forecastMrr(hist, 6, 12);
  const labels = M.range(1, N + 6).map(monthLabel);
  const pad = Array(N - 1).fill(null);
  const last = hist[N - 1];
  // Shade Months N-3..N (recent 4) and the forecast region; mark the origin.
  const regions = {
    id: 'regions',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea: a, scales: { x } } = chart;
      const step = x.getPixelForValue(1) - x.getPixelForValue(0);
      ctx.save();
      ctx.fillStyle = C.highlight;
      const x0 = x.getPixelForValue(N - 4) - step / 2, xo = x.getPixelForValue(N - 1);
      ctx.fillRect(x0, a.top, xo - x0, a.bottom - a.top);
      ctx.fillStyle = C.forecastBg;
      ctx.fillRect(xo, a.top, a.right - xo, a.bottom - a.top);
      ctx.strokeStyle = C.muted; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(xo, a.top); ctx.lineTo(xo, a.bottom); ctx.stroke();
      ctx.setLineDash([]); ctx.fillStyle = C.muted; ctx.font = '11px ' + Chart.defaults.font.family;
      ctx.textAlign = 'center'; ctx.fillText('Last 4 months', (x0 + xo) / 2, a.top + 12);
      ctx.textAlign = 'left'; ctx.fillText('Forecast →', xo + 6, a.top + 12);
      ctx.restore();
    },
  };
  draw('c-mrr', {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Observed MRR', data: [...hist, ...Array(6).fill(null)], borderColor: C.s1, backgroundColor: C.s1 },
        { label: 'Forecast', data: [...pad, last, ...fc.map(p => p.value)], borderColor: C.s1, borderDash: [6, 4], backgroundColor: C.s1 },
        { label: '80% interval (high)', data: [...pad, last, ...fc.map(p => p.high)], borderWidth: 0, pointHoverRadius: 0, backgroundColor: C.highlight, fill: '+1' },
        { label: '80% interval (low)', data: [...pad, last, ...fc.map(p => p.low)], borderWidth: 0, pointHoverRadius: 0, fill: false },
      ],
    },
    options: {
      plugins: {
        legend: { labels: { filter: i => i.datasetIndex < 2 } },
        tooltip: {
          filter: i => i.raw != null && i.datasetIndex !== 3 && !(i.datasetIndex > 0 && i.dataIndex === N - 1),
          callbacks: {
            title: items => `${items[0].label} · Month ${items[0].dataIndex + 1}${items[0].dataIndex >= N ? ' (forecast)' : ''}`,
            label: i => i.datasetIndex === 2 ? `80% interval: ${peso.format(fc[i.dataIndex - N].low)} – ${peso.format(i.raw)}` : `${i.dataset.label}: ${peso.format(i.raw)}`,
          },
        },
      },
      scales: { y: { beginAtZero: true, ticks: { callback: pesoShort }, title: axisTitle('MRR (₱, monthly-equivalent)') }, x: { ticks: { maxRotation: 0, autoSkipPadding: 12 }, grid: { display: false } } },
    },
    plugins: [regions],
  });
  const slope = fc[0].slope;
  $('mrr-desc').textContent = `Observed Months 1–${N} (solid) and Months ${N + 1}–${N + 6} forecast (dashed), shown for the full history regardless of the period filter. ` +
    `Method: least-squares linear trend over the last 12 observed months (${slope >= 0 ? '+' : '−'}${peso.format(Math.abs(slope))}/month), projected from the last observed value; ` +
    `shaded band = 80% interval from month-to-month variation; floored at ₱0. Illustrative only — computed from synthetic data, not a business prediction.`;
}

// ---------- Period-dependent sections ----------
function render(len) {
  const a = N - len + 1, b = N, ms = M.range(a, b), labels = ms.map(monthLabel);
  const periodName = len === N ? `Months 1–${N}` : `${monthLabel(a)} – ${monthLabel(b)}`;

  // KPIs
  const { current: k, prior: p } = M.kpis(data, a, b);
  const priorTxt = p ? `vs prior ${len} mo` : 'no prior period in data';
  const chg = (cur, prev) => !p || prev == null || cur == null ? priorTxt : prev === 0 ? `${priorTxt}: n/a` : `${cur >= prev ? '▲' : '▼'} ${Math.abs((cur - prev) / prev * 100).toFixed(1)}% ${priorTxt}`;
  const pp = (cur, prev) => !p || prev == null || cur == null ? priorTxt : `${cur >= prev ? '▲' : '▼'} ${Math.abs((cur - prev) * 100).toFixed(2)} pp ${priorTxt}`;
  const cards = [
    ['Active subscribed facilities', int.format(k.subscribed), chg(k.subscribed, p?.subscribed), `At end of ${monthLabel(b)}`],
    ['Monthly recurring revenue', peso.format(k.mrr), chg(k.mrr, p?.mrr), `At end of ${monthLabel(b)}`],
    ['New facilities', int.format(k.newFacilities), chg(k.newFacilities, p?.newFacilities), 'First subscriptions in period'],
    ['Facility churn rate (monthly)', pct(k.churn, 2), pp(k.churn, p?.churn), 'Avg. per month in period'],
    ['Monthly active facilities', int.format(k.mau), chg(k.mau, p?.mau), `${monthLabel(b)}; ≥1 encounter`],
    ['Patient encounters', int.format(k.encounters), chg(k.encounters, p?.encounters), 'Total in period'],
  ];
  $('kpis').innerHTML = cards.map(([l, v, d, t]) => `<div class="kpi" title="${t}"><div class="label">${l}</div><div class="value">${v}</div><div class="delta">${d}</div></div>`).join('');

  // B2 subscribed by plan
  const subsByMonth = ms.map(m => [...M.subscribedAt(data, m).values()]);
  draw('c-subs', {
    type: 'bar',
    data: { labels, datasets: data.plans.map(pl => ({ label: pl.name, data: subsByMonth.map(s => s.filter(x => x.plan_id === pl.plan_id).length), backgroundColor: PLAN_COLOR[pl.plan_id], borderColor: C.card, borderWidth: { top: 2 }, borderSkipped: false })) },
    options: { scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, title: axisTitle('Facilities') } }, plugins: { tooltip: { callbacks: { footer: it => `Total: ${it.reduce((s, i) => s + i.raw, 0)}` } } } },
  });

  // B3 new vs cancelled
  draw('c-flow', {
    type: 'bar',
    data: { labels, datasets: [
      { label: 'New facilities', data: ms.map(m => M.newFacilities(data, m).length), backgroundColor: C.s1 },
      { label: 'Cancelled', data: ms.map(m => -M.churnedIn(data, m).length), backgroundColor: C.s2 },
    ] },
    options: { scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, ticks: { callback: v => Math.abs(v) }, title: axisTitle('Facilities') } }, plugins: { tooltip: { callbacks: { label: i => `${i.dataset.label}: ${Math.abs(i.raw)}` } } } },
  });

  // B4 plan & add-on mix at period end
  const subsEnd = M.subscribedAt(data, b), mrrEnd = M.mrrAt(data, b);
  const planRows = data.plans.map(pl => {
    const s = [...subsEnd.values()].filter(x => x.plan_id === pl.plan_id);
    return { label: pl.name, n: s.length, mrr: s.reduce((t, x) => t + M.planMrr(data, x), 0) };
  });
  const endIso = M.monthIso(data, b + 1);
  const addonRows = data.addons.filter(x => x.recurring).map(ad => {
    const holders = new Set(data.subscription_addons.filter(x => x.addon_id === ad.addon_id && subsEnd.has(x.facility_id) && x.start_date < endIso && (x.end_date == null || x.end_date >= endIso)).map(x => x.facility_id));
    return { label: ad.name, share: subsEnd.size ? holders.size / subsEnd.size : null };
  });
  const bar = (label, frac, txt, color = C.s1) => `<div class="bar-row"><span>${label}</span><div class="track"><div class="fill" style="width:${(frac ?? 0) * 100}%;background:${color}"></div></div><span class="num">${txt}</span></div>`;
  $('mix-desc').textContent = `At end of ${monthLabel(b)}: facilities by plan (plan MRR), and share of subscribed facilities holding each recurring add-on.`;
  $('mix').innerHTML = planRows.map(r => bar(`${r.label}`, r.n / subsEnd.size, `${r.n} · ${pesoShort(r.mrr)}`, PLAN_COLOR[data.plans.find(p => p.name === r.label).plan_id])).join('') +
    bar('Add-ons · share of MRR', mrrEnd.addon / mrrEnd.total, pesoShort(mrrEnd.addon), C.neutral) +
    '<div style="height:6px"></div>' + addonRows.map(r => bar(r.label, r.share, pct(r.share, 0), C.neutral)).join('');
  const usage = M.usageIn(data, a, b);
  const tokenRev = usage.reduce((s, r) => s + r.token_rev, 0);
  $('token-note').textContent = `SugboDoc Token purchases in period: ${peso.format(tokenRev)} — non-recurring (billing interval unconfirmed), excluded from MRR.`;

  // C stats strip
  const sumOf = (rs, f) => rs.reduce((s, r) => s + r[f], 0);
  const lastRows = usage.filter(r => r.m === b);
  const apptRows = usage.filter(r => r.modules.includes('appointments'));
  const appts = sumOf(apptRows, 'appt_done') + sumOf(apptRows, 'appt_cancel') + sumOf(apptRows, 'appt_noshow');
  const enc = sumOf(usage, 'enc');
  const stats = [
    [`${int.format(sumOf(lastRows, 'active_docs'))} / ${int.format(sumOf(lastRows, 'rostered'))}`, `Active / rostered doctors, ${monthLabel(b)}`],
    [int.format(sumOf(lastRows, 'patients')), `Unique patients seen, ${monthLabel(b)}`],
    [appts ? pct(sumOf(apptRows, 'appt_done') / appts) : 'n/a', `Appointments completed (${appts ? pct(sumOf(apptRows, 'appt_cancel') / appts) : 'n/a'} cancelled, ${appts ? pct(sumOf(apptRows, 'appt_noshow') / appts) : 'n/a'} no-show)`],
    [enc ? num(sumOf(usage, 'notes') / enc, 2) : 'n/a', 'Clinical notes per encounter'],
    [enc ? num(sumOf(usage, 'rx') / enc, 2) : 'n/a', 'Prescriptions per encounter'],
    [enc ? pct(sumOf(usage, 'ai_tx') / enc) : 'n/a', `Encounters with AI assist (${(sumOf(usage, 'ai_tokens') / 1e6).toFixed(1)}M tokens)`],
  ];
  $('usage-stats').innerHTML = stats.map(([v, l]) => `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');

  // C1 encounters by category
  const cats = [['OPD', 'opd', C.s1], ['IPD', 'ipd', C.s2], ['ER', 'er', C.s3], ['Other', 'other', C.neutral]];
  draw('c-enc', {
    type: 'bar',
    data: { labels, datasets: cats.map(([label, f, color]) => ({ label, data: ms.map(m => sumOf(usage.filter(r => r.m === m), f)), backgroundColor: color, borderColor: C.card, borderWidth: { top: 2 }, borderSkipped: false })) },
    options: { scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, title: axisTitle('Encounters') } }, plugins: { tooltip: { callbacks: { label: i => `${i.dataset.label}: ${int.format(i.raw)}` } } } },
  });

  // C2 adoption breadth
  const share = (m, pred) => { const rs = usage.filter(r => r.m === m); return rs.length ? rs.filter(pred).length / rs.length * 100 : null; };
  draw('c-adopt', {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Active (≥1 encounter)', data: ms.map(m => share(m, r => r.enc > 0)), borderColor: C.s1, backgroundColor: C.s1 },
      { label: 'Used 4+ modules', data: ms.map(m => share(m, r => r.modules.length >= 4)), borderColor: C.s2, backgroundColor: C.s2 },
    ] },
    options: { scales: { y: { min: 0, max: 100, ticks: { callback: v => v + '%' }, title: axisTitle('% of subscribed facilities') }, x: { grid: { display: false } } }, plugins: { tooltip: { callbacks: { label: i => `${i.dataset.label}: ${i.raw == null ? 'n/a' : i.raw.toFixed(1) + '%'}` } } } },
  });

  // C3 module adoption (latest month of period)
  $('mod-desc').textContent = `Share of subscribed facilities using each module in ${monthLabel(b)} (≥1 record).`;
  $('modules').innerHTML = M.moduleAdoption(data, b).map(x => bar(MODULE_LABEL[x.module], x.share, pct(x.share, 0))).join('');

  // C4 segment table
  const seg = M.usageBySegment(data, a, b);
  $('seg').innerHTML = '<tr><th>Segment</th><th>Facility-months</th><th>% active</th><th>Active days / mo</th><th>Encounters / doctor / mo</th><th>Modules used</th></tr>' +
    seg.map(s => `<tr><td>${s.label}</td><td>${s.n}</td>${s.n ? `<td>${pct(s.activeShare, 0)}</td><td>${num(s.activeDays, 1)}</td><td>${num(s.encPerDoctor, 1)}</td><td>${num(s.modules, 1)}</td>` : '<td colspan="4">no facility-months</td>'}</tr>`).join('');

  $('subtitle').textContent = `Reporting period: ${periodName} · Data Months 1–${N} (${monthLabel(1)} – ${monthLabel(N)})`;
}

// ---------- Static: retention diagnostics (full history) ----------
function drawRetention() {
  const plans = data.plans.map(pl => ({ name: pl.name, id: pl.plan_id, ...M.churnRate(data, 1, N, pl.plan_id) }));
  draw('c-churn-plan', {
    type: 'bar',
    data: { labels: plans.map(p => p.name), datasets: [{ label: 'Monthly churn rate', data: plans.map(p => p.rate * 100), backgroundColor: plans.map(p => PLAN_COLOR[p.id]) }] },
    options: { plugins: { legend: { display: false }, tooltip: { callbacks: { label: i => `${i.raw.toFixed(2)}% · ${plans[i.dataIndex].churned} cancellations / ${int.format(plans[i.dataIndex].base)} facility-months` } } }, scales: { y: { beginAtZero: true, ticks: { callback: v => v + '%' }, title: axisTitle('Monthly churn rate') }, x: { grid: { display: false } } } },
  });

  const bands = M.churnByBreadth(data);
  draw('c-churn-breadth', {
    type: 'bar',
    data: { labels: bands.map(b => b.label), datasets: [{ label: 'Monthly churn rate', data: bands.map(b => b.rate == null ? null : b.rate * 100), backgroundColor: C.s1 }] },
    options: { plugins: { legend: { display: false }, tooltip: { callbacks: { label: i => `${i.raw.toFixed(2)}% · ${bands[i.dataIndex].churned} cancellations / ${int.format(bands[i.dataIndex].base)} facility-months` } } }, scales: { y: { beginAtZero: true, ticks: { callback: v => v + '%' }, title: axisTitle('Monthly churn rate') }, x: { title: axisTitle('Modules used in prior month'), grid: { display: false } } } },
  });

  const t = M.preChurnTrajectory(data);
  $('traj-desc').textContent = `Encounters per rostered doctor, each facility indexed to its own 6-month mean (=100); median shown. Churned: 6 months before cancellation (n=${t.nChurned}). Retained: Months ${N - 5}–${N} (n=${t.nRetained}).`;
  draw('c-traj', {
    type: 'line',
    data: { labels: t.offsets.map(o => `${o} mo`), datasets: [
      { label: `Churned (n=${t.nChurned})`, data: t.churned, borderColor: C.s2, backgroundColor: C.s2, pointRadius: 3 },
      { label: `Retained (n=${t.nRetained})`, data: t.retained, borderColor: C.s1, backgroundColor: C.s1, pointRadius: 3 },
    ] },
    options: { scales: { y: { title: axisTitle('Index (own 6-mo mean = 100)') }, x: { title: axisTitle('Months before cancellation / before latest month'), grid: { display: false } } }, plugins: { tooltip: { callbacks: { label: i => `${i.dataset.label}: ${num(i.raw, 0)}` } } } },
  });

  const r = M.retainedVsChurned(data);
  const row = (label, g) => `<tr><td>${label}</td><td>${g.n}</td><td>${num(g.activeDays, 1)}</td><td>${num(g.encPerDoctor, 1)}</td><td>${num(g.modules, 1)}</td></tr>`;
  $('rvc').innerHTML = '<tr><th>Group · window</th><th>n</th><th>Active days / mo</th><th>Encounters / doctor / mo</th><th>Modules used</th></tr>' +
    row('Churned · first 3 months', r.churned.first) + row('Retained · first 3 months', r.retained.first) +
    row('Churned · final 3 months', r.churned.last) + row('Retained · final 3 months', r.retained.last);
  $('rvc-note').textContent = `Overlap is substantial: ${pct(r.churnedAboveMedianShare, 0)} of churned facilities were above the overall median encounters per doctor in their final 3 months. Final window = 3 months before cancellation (churned) or Months ${N - 2}–${N} (retained).`;
}

// ---------- Definitions ----------
const defs = [
  ['Active subscribed facility', 'A facility account with a subscription period covering the last day of the month. One count per facility, regardless of branches or locations.'],
  ['MRR', `Sum at month end of monthly-equivalent recurring charges: plan list price × (1 − facility discount) × (1 − ${data.assumptions.annual_discount * 100}% if billed annually), plus active recurring add-ons (Staff, Private Insurance Claims, Add Features, Storage, Add Branches, Imaging Storage) at list price × quantity. Token purchases and other one-time revenue are excluded.`],
  ['New facilities', 'Facilities whose first-ever subscription started in the period. Plan changes and add-ons are not new facilities.'],
  ['Facility churn rate', 'Cancellations in month m ÷ facilities subscribed at the start of month m (end of m−1), averaged over the period as Σ cancellations ÷ Σ opening facilities. Plan changes are not churn; facilities never subscribed are excluded.'],
  ['Monthly active facility', 'A subscribed facility with at least one patient encounter recorded in the calendar month. Distinct from subscribed facilities.'],
  ['Patient encounters', 'Encounter records dated within the period (OPD, IPD, ER, Other). Birthing-home deliveries are IPD; prenatal/postnatal/general visits are OPD with a maternity-service attribute.'],
  ['Appointment rates', 'Completed, cancelled and no-show appointments ÷ all appointments, among facilities using the appointments module that month. Facilities not using the module are not counted as zero.'],
  ['Active doctors', 'Rostered doctors with ≥1 encounter in the month.'],
  ['Module adoption', 'A module is used in a month if the facility created ≥1 record in it (encounter, clinical note, prescription, appointment, invoice, insurance claim, AI transaction). Breadth = number of the 7 modules used.'],
  ['Retention comparisons', 'Churned = cancelled within Months 1–24; retained = subscribed at end of Month 24. Per-facility monthly averages, then medians. Associations only; they do not establish that low engagement causes churn.'],
  ['Zero vs. n/a', 'Zero = facility was subscribed and recorded no activity. n/a = metric not applicable (e.g. no prior period inside the data, module not used, no facilities in segment).'],
  ['MRR forecast', 'Least-squares linear trend fitted to the last 12 observed months, anchored at the last observed MRR so history and forecast join at Month 24, extended 6 months. 80% band = ±1.28·σ·√h with σ the spread of month-over-month changes around the trend; values floored at ₱0. Uses observed months only.'],
  ['Data', `Synthetic, generated with seed ${data.generated_with_seed}. Prices are listed reference prices; discounts, annual billing and token bundle size (${int.format(data.assumptions.tokens_per_bundle)} tokens assumed) are modelling assumptions. Not actual SugboDoc customers.`],
];
$('defs').innerHTML = defs.map(([t, d]) => `<dt>${t}</dt><dd>${d}</dd>`).join('');

drawMrr();
drawRetention();
const period = $('period');
render(Number(period.value));
period.addEventListener('change', () => render(Number(period.value)));
