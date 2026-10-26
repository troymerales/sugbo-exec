import * as M from './metrics.js';

const data = await (await fetch('data/dashboard.json')).json();
const N = data.months.length;
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const C = { s1: css('--s1'), s2: css('--s2'), s3: css('--s3'), s4: css('--s4'), s5: css('--s5'), s6: css('--s6'), neutral: css('--neutral'), text2: css('--text-2'), muted: css('--muted'), grid: css('--grid'), highlight: css('--highlight'), forecastBg: css('--forecast-bg'), card: css('--card') };
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
Chart.defaults.elements.line.borderWidth = 2.5;
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
  const TEST = 4, trainEnd = N - TEST; // train Months 1–20, test Months 21–24
  const fc = M.forecastMrr(hist.slice(0, trainEnd), TEST + 6, 12); // one forecast: Months 21–30
  const mape = M.backtestMrr(hist, TEST, 12).mape;
  const labels = M.range(1, N + 6).map(monthLabel);
  const pad = Array(trainEnd - 1).fill(null), origin = hist[trainEnd - 1];
  // Shade the test window and the forecast-only region; mark the forecast origin (Month 20).
  const regions = {
    id: 'regions',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea: a, scales: { x } } = chart;
      const xo = x.getPixelForValue(trainEnd - 1), xt = x.getPixelForValue(N - 1);
      ctx.save();
      ctx.fillStyle = C.highlight; ctx.fillRect(xo, a.top, xt - xo, a.bottom - a.top);
      ctx.fillStyle = C.forecastBg; ctx.fillRect(xt, a.top, a.right - xt, a.bottom - a.top);
      ctx.strokeStyle = C.muted; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(xo, a.top); ctx.lineTo(xo, a.bottom); ctx.stroke();
      ctx.setLineDash([]); ctx.fillStyle = C.muted; ctx.font = '11px ' + Chart.defaults.font.family;
      ctx.textAlign = 'right'; ctx.fillText(`Train · Months 1–${trainEnd}`, xo - 6, a.top + 12);
      ctx.textAlign = 'center'; ctx.fillText(`Test · ${trainEnd + 1}–${N}`, (xo + xt) / 2, a.top + 12);
      ctx.textAlign = 'left'; ctx.fillText('Forecast →', xt + 6, a.top + 12);
      ctx.restore();
    },
  };
  draw('c-mrr', {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Observed MRR', data: [...hist, ...Array(6).fill(null)], borderColor: C.s1, borderWidth: 3, fill: 'origin',
          backgroundColor: ({ chart: { ctx, chartArea: ca } }) => { if (!ca) return C.s1 + '22'; const g = ctx.createLinearGradient(0, ca.top, 0, ca.bottom); g.addColorStop(0, C.s1 + '40'); g.addColorStop(1, C.s1 + '00'); return g; } },
        { label: `Forecast (trained on Months 1–${trainEnd})`, data: [...pad, origin, ...fc.map(p => p.value)], borderColor: C.s1, borderDash: [2, 4], backgroundColor: C.s1 },
        { label: '80% interval (high)', data: [...pad, origin, ...fc.map(p => p.high)], borderWidth: 0, pointHoverRadius: 0, backgroundColor: C.highlight, fill: '+1' },
        { label: '80% interval (low)', data: [...pad, origin, ...fc.map(p => p.low)], borderWidth: 0, pointHoverRadius: 0, fill: false },
      ],
    },
    options: {
      plugins: {
        legend: { labels: { filter: i => i.datasetIndex < 2 } },
        tooltip: {
          filter: i => i.raw != null && i.datasetIndex !== 3 && !(i.datasetIndex > 0 && i.dataIndex === trainEnd - 1),
          callbacks: {
            title: items => `${items[0].label} · Month ${items[0].dataIndex + 1}${items[0].dataIndex >= N ? ' (forecast)' : items[0].dataIndex >= trainEnd ? ' (test)' : ''}`,
            label: i => i.datasetIndex === 2 ? `80% interval: ${peso.format(fc[i.dataIndex - trainEnd].low)} – ${peso.format(i.raw)}`
              : i.datasetIndex === 1 && i.dataIndex < N ? `Forecast: ${peso.format(i.raw)} (error ${pct((i.raw - hist[i.dataIndex]) / hist[i.dataIndex])} vs actual)`
              : `${i.dataset.label.replace(/ \(.*/, '')}: ${peso.format(i.raw)}`,
          },
        },
      },
      scales: { y: { beginAtZero: true, ticks: { callback: pesoShort }, title: axisTitle('MRR (₱, monthly-equivalent)') }, x: { ticks: { maxRotation: 0, autoSkipPadding: 12 }, grid: { display: false } } },
    },
    plugins: [regions],
  });
  const slope = fc[0].slope;
  $('mrr-desc').textContent = `Observed MRR, Months 1–${N} (solid). One forecast (dotted), fitted on Months 1–${trainEnd} only and run from Month ${trainEnd} to Month ${N + 6}: ` +
    `Months ${trainEnd + 1}–${N} are the test against actuals (MAPE ${pct(mape)}), Months ${N + 1}–${N + 6} are the forward forecast. ` +
    `Method: least-squares linear trend over the 12 training months before the origin (${slope >= 0 ? '+' : '−'}${peso.format(Math.abs(slope))}/month), projected from the Month ${trainEnd} value; ` +
    `band = 80% interval from month-to-month variation; floored at ₱0. Full history shown regardless of the period filter. Illustrative only — synthetic data, not a business prediction.`;
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
  // Delta colour = business impact, not direction: 'good' / 'bad' / 'na' (no prior, n/a, or unchanged).
  const tone = (cur, prev, lowerIsBetter = false) => !p || prev == null || cur == null || cur === prev ? 'na' : (cur > prev) !== lowerIsBetter ? 'good' : 'bad';
  const toneChg = (cur, prev) => prev === 0 ? 'na' : tone(cur, prev); // chg() prints "n/a" when prior is 0
  const cards = [
    ['Active subscribed facilities', int.format(k.subscribed), chg(k.subscribed, p?.subscribed), `At end of ${monthLabel(b)}`, toneChg(k.subscribed, p?.subscribed)],
    ['Monthly recurring revenue', peso.format(k.mrr), chg(k.mrr, p?.mrr), `At end of ${monthLabel(b)}`, toneChg(k.mrr, p?.mrr)],
    ['New facilities', int.format(k.newFacilities), chg(k.newFacilities, p?.newFacilities), 'First subscriptions in period', toneChg(k.newFacilities, p?.newFacilities)],
    ['Facility churn rate (monthly)', pct(k.churn, 2), pp(k.churn, p?.churn), 'Avg. per month in period', tone(k.churn, p?.churn, true)],
    ['Monthly active facilities', int.format(k.mau), chg(k.mau, p?.mau), `${monthLabel(b)}; ≥1 encounter`, toneChg(k.mau, p?.mau)],
    ['Patient encounters', int.format(k.encounters), chg(k.encounters, p?.encounters), 'Total in period', toneChg(k.encounters, p?.encounters)],
  ];
  $('kpis').innerHTML = cards.map(([l, v, d, t, tn]) => `<div class="kpi" title="${t}"><div class="label">${l}</div><div class="value">${v}</div><div class="delta ${tn}">${d}</div></div>`).join('');

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

  // Marketing analytics (social + website)
  const CHANNEL_COLOR = { cold_calling: C.s1, facebook: C.s2, instagram: C.s3, linkedin: C.s4, website: C.s5, organic_direct: C.s5, referral: C.s6 };
  const PLATFORM_NAME = { facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn', organic_direct: 'Organic / direct' };
  const platforms = ['facebook', 'instagram', 'linkedin'];
  const social = M.socialSummary(data, a, b), web = M.websiteTotals(data, a, b);
  const socialTot = k => social.reduce((t, x) => t + x[k], 0);
  const socialRow = (p, m) => data.social_metrics.find(r => r.platform === p && r.month === data.months[m - 1].key);
  $('mkt-stats').innerHTML = [
    [int.format(web.sessions), 'Website sessions'],
    [int.format(web.pageViews), 'Page views'],
    [int.format(socialTot('engagements')), 'Social engagements (likes, comments, shares)'],
    [pct(socialTot('engagements') / socialTot('impressions'), 2), 'Avg. social engagement rate'],
    [int.format(socialTot('newFollowers')), 'New followers'],
    [int.format(socialTot('linkClicks')), 'Link clicks to website'],
  ].map(([v, l]) => `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');
  const stackedOpts = (yTitle, fmt = v => int.format(v)) => ({ scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, title: axisTitle(yTitle) } }, plugins: { tooltip: { callbacks: { label: i => `${i.dataset.label}: ${fmt(i.raw)}`, footer: it => `Total: ${int.format(it.reduce((t, i) => t + i.raw, 0))}` } } } });
  draw('c-social', {
    type: 'bar',
    data: { labels, datasets: platforms.map(p => ({ label: PLATFORM_NAME[p], data: ms.map(m => { const r = socialRow(p, m); return r.likes + r.comments + r.shares; }), backgroundColor: CHANNEL_COLOR[p], borderColor: C.card, borderWidth: { top: 2 }, borderSkipped: false })) },
    options: stackedOpts('Engagements'),
  });
  draw('c-web', {
    type: 'bar',
    data: { labels, datasets: ['organic_direct', ...platforms].map(src => ({ label: PLATFORM_NAME[src], data: ms.map(m => data.website_traffic.find(r => r.source === src && r.month === data.months[m - 1].key).sessions), backgroundColor: CHANNEL_COLOR[src], borderColor: C.card, borderWidth: { top: 2 }, borderSkipped: false })) },
    options: stackedOpts('Sessions'),
  });
  draw('c-eng-rate', {
    type: 'line',
    data: { labels, datasets: platforms.map(p => ({ label: PLATFORM_NAME[p], data: ms.map(m => { const r = socialRow(p, m); return (r.likes + r.comments + r.shares) / r.impressions * 100; }), borderColor: CHANNEL_COLOR[p], backgroundColor: CHANNEL_COLOR[p] })) },
    options: { scales: { y: { beginAtZero: true, ticks: { callback: v => v + '%' }, title: axisTitle('Engagement rate') }, x: { grid: { display: false } } }, plugins: { tooltip: { callbacks: { label: i => `${i.dataset.label}: ${i.raw.toFixed(2)}%` } } } },
  });
  $('social').innerHTML = '<tr><th>Platform</th><th>Followers (end)</th><th>New followers</th><th>Impressions</th><th>Likes</th><th>Comments</th><th>Shares</th><th>Engagements</th><th>Engagement rate</th><th>Link clicks</th></tr>' +
    social.map(x => `<tr><td>${PLATFORM_NAME[x.platform]}</td><td>${int.format(x.followers)}</td><td>${int.format(x.newFollowers)}</td><td>${int.format(x.impressions)}</td><td>${int.format(x.likes)}</td><td>${int.format(x.comments)}</td><td>${int.format(x.shares)}</td><td>${int.format(x.engagements)}</td><td>${pct(x.engagementRate, 2)}</td><td>${int.format(x.linkClicks)}</td></tr>`).join('');
  $('social-desc').textContent = `${periodName}. Followers at end of ${monthLabel(b)}. Link clicks land on the website and appear there as sessions from that platform.`;

  // Lead generation funnel (lead cohort engaged in period)
  const sk = M.funnelSankey(data, a, b);
  const nodeTotals = {};
  for (const f of sk.flows) { nodeTotals[f.to] = (nodeTotals[f.to] || 0) + f.flow; if (sk.column[f.from] === 0) nodeTotals[f.from] = (nodeTotals[f.from] || 0) + f.flow; }
  const progress = new Set(['Engaged', ...M.STAGES.map(s => s[1]), 'Re-subscribed']);
  const nodeColor = name => { const ch = data.channels.find(c => c.name === name); return ch ? CHANNEL_COLOR[ch.channel] : progress.has(name) ? C.s1 : C.neutral; };
  draw('c-sankey', {
    type: 'sankey',
    data: { datasets: [{
      data: sk.flows, column: sk.column, priority: { ...Object.fromEntries(data.channels.map((c, i) => [c.name, i])), [`Cancelled ≤ ${M.RESUB_DAYS} days`]: 0, 'Re-subscribed': 1 }, size: 'max', nodeWidth: 12, nodePadding: 36, borderWidth: 0,
      labels: Object.fromEntries(Object.keys(nodeTotals).map(k => [k, `${k} · ${int.format(nodeTotals[k])}`])),
      colorFrom: c => nodeColor(c.dataset.data[c.dataIndex].from), colorTo: c => nodeColor(c.dataset.data[c.dataIndex].to), colorMode: 'gradient',
      color: C.text2, font: { size: 11.5 },
    }] },
    options: { plugins: { legend: { display: false }, tooltip: { mode: 'nearest', intersect: true, callbacks: { title: () => '', label: i => { const f = i.raw; const out = nodeTotals[f.from]; return `${f.from} → ${f.to}: ${int.format(f.flow)}${out ? ` (${pct(f.flow / out)} of ${f.from})` : ''}`; } } } } },
  });
  $('sankey-desc').textContent = `${int.format(sk.total)} leads first engaged ${periodName}. Re-subscribed = converted facilities still paying ${M.RESUB_DAYS} days later, plus lapsed leads (no demo, no trial, not converted) that came back and subscribed. Not shown: ${sk.tooRecent} conversion${sk.tooRecent === 1 ? '' : 's'} less than ${M.RESUB_DAYS} days old (too recent to tell) and ${sk.open} lead${sk.open === 1 ? '' : 's'} still in progress. Follows the engagement cohort, so totals differ from "New facilities" (counted by subscription start).`;

  const chans = M.channelSummary(data, a, b);
  const short = c => c.name.replace(' (organic/direct)', '');
  draw('c-chan-convs', {
    type: 'bar',
    data: { labels: chans.map(short), datasets: [
      { label: 'Converted', data: chans.map(c => c.converted_date), backgroundColor: chans.map(c => CHANNEL_COLOR[c.channel]) },
      { label: 'Won back later', data: chans.map(c => c.wonBack), backgroundColor: chans.map(c => CHANNEL_COLOR[c.channel] + '80'), borderColor: C.card, borderWidth: { bottom: 2 }, borderSkipped: false },
    ] },
    options: { plugins: { tooltip: { callbacks: { label: i => `${i.dataset.label}: ${i.raw}`, footer: it => `${chans[it[0].dataIndex].customers} new facilities · ${pct(chans[it[0].dataIndex].conversionShare, 0)} of all` } } }, scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 }, title: axisTitle('New paying facilities') } } },
  });
  draw('c-chan-conv', {
    type: 'bar',
    data: { labels: chans.map(short), datasets: [{ label: 'Lead-to-customer', data: chans.map(c => c.leadToCustomer == null ? null : c.leadToCustomer * 100), backgroundColor: chans.map(c => CHANNEL_COLOR[c.channel]) }] },
    options: { plugins: { legend: { display: false }, tooltip: { callbacks: { label: i => `${i.raw.toFixed(1)}% · ${chans[i.dataIndex].converted_date} of ${int.format(chans[i.dataIndex].leads)} leads` } } }, scales: { y: { beginAtZero: true, ticks: { callback: v => v + '%' }, title: axisTitle('Converted ÷ engaged leads') }, x: { grid: { display: false } } } },
  });

  const all = M.funnelCounts(data, M.leadsIn(data, a, b));
  const stageSteps = M.STAGES.slice(1).map(([col, label], i) => [`${M.STAGES[i][1]} → ${label}`, all[M.STAGES[i][0]] ? all[col] / all[M.STAGES[i][0]] : null]);
  const matured = all.resubscribed + all.cancelled;
  stageSteps.push(['Converted → Re-subscribed', matured ? all.resubscribed / matured : null]);
  const lapsed = all.inquired_date - all.converted_date - all.open;
  stageSteps.push(['Lapsed → Won back', lapsed > 0 ? all.wonBack / lapsed : null]);
  $('stage-bars').innerHTML = stageSteps.map(([l, v]) => bar(l, v, pct(v, 0))).join('') +
    `<p class="callout">Re-subscribed rate excludes conversions with fewer than ${M.RESUB_DAYS} days of follow-up.</p>`;

  const chanRow = (name, c, unit) => `<td>${name}</td><td>${c.volume == null ? 'n/a' : `${int.format(c.volume)} <span style="color:var(--muted)">${unit}</span>`}</td><td>${int.format(c.leads)}</td><td>${c.volumeToLead == null ? 'n/a' : pct(c.volumeToLead)}</td><td>${c.inquired_date}</td><td>${c.demo_date}</td><td>${c.trial_start_date}</td><td>${c.converted_date}</td><td>${c.wonBack}</td><td>${pct(c.conversionShare, 0)}</td><td>${pct(c.leadToCustomer)}</td><td>${pct(c.resubRate, 0)}</td><td>${peso.format(c.planMrr)}</td>`;
  const totals = Object.fromEntries(['leads', 'inquired_date', 'demo_date', 'trial_start_date', 'converted_date', 'wonBack', 'resubscribed', 'cancelled', 'planMrr'].map(k => [k, chans.reduce((t, c) => t + c[k], 0)]));
  Object.assign(totals, { volume: null, volumeToLead: null, conversionShare: totals.converted_date ? 1 : null, leadToCustomer: totals.leads ? totals.converted_date / totals.leads : null, resubRate: totals.resubscribed + totals.cancelled ? totals.resubscribed / (totals.resubscribed + totals.cancelled) : null });
  $('chan').innerHTML = '<tr><th>Channel</th><th>Top-of-funnel volume</th><th>Engaged leads</th><th>Volume → lead</th><th>Inquired</th><th>Demo</th><th>Free trial</th><th>Converted</th><th>Won back</th><th>Share of new facilities</th><th>Lead → customer</th><th>Re-subscribed</th><th>Plan MRR now</th></tr>' +
    chans.map(c => `<tr>${chanRow(c.name, c, c.volume_unit)}</tr>`).join('') + `<tr class="total">${chanRow('All channels', totals, '')}</tr>`;
  $('chan-desc').textContent = `Top-of-funnel volume is in each channel's own unit (calls, site sessions, referrals) for ${periodName}, so it is not summed. Funnel columns follow the lead cohort engaged in the period. Plan MRR now = plan MRR at end of ${monthLabel(b)} from facilities converted from these leads (add-ons excluded). No spend data, so no CAC.`;

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
  ['Marketing analytics', 'Social: impressions, likes, comments, shares, new followers and link clicks per platform per month. Engagements = likes + comments + shares; engagement rate = engagements ÷ impressions. Website: sessions and page views by source (organic/direct, Facebook, Instagram, LinkedIn).'],
  ['Lead funnel', `Sources: cold calling, Facebook, Instagram, LinkedIn, website (organic/direct), referral. Engaged = identifiable facility prospect (interested call, form view, DM, referral). Inquired, Demo, Free trial (${data.trial_days} days) and Converted are stages reached by the end of the data; a converted lead becomes the facility's first subscription. Re-subscribed = still subscribed ${M.RESUB_DAYS} days after conversion, or a lapsed lead (dropped after inquiring) that came back 1–5 months later and subscribed ("won back"); won-back leads become facilities like converted ones. Cohort = first engagement in the period. Channel traffic, stage rates and single-source attribution are synthetic assumptions.`],
  ['MRR forecast', 'One forecast line with a train/test split: least-squares linear trend fitted to Months 9–20 (the 12 months before the origin), anchored at the Month 20 value so it joins the actual series there, run through Month 30. Months 21–24 are compared with actuals (MAPE); Months 25–30 are the forward forecast. 80% band = ±1.28·σ·√h with σ the spread of month-over-month changes around the trend; values floored at ₱0. Uses observed months only.'],
  ['Data', `Synthetic, generated with seed ${data.generated_with_seed}. Prices are listed reference prices; discounts, annual billing and token bundle size (${int.format(data.assumptions.tokens_per_bundle)} tokens assumed) are modelling assumptions. Not actual SugboDoc customers.`],
];
$('defs').innerHTML = defs.map(([t, d]) => `<dt>${t}</dt><dd>${d}</dd>`).join('');

drawMrr();
drawRetention();
const period = $('period');
render(Number(period.value));
period.addEventListener('change', () => render(Number(period.value)));
