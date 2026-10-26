# SugboDoc Executive Dashboard (synthetic data)

A single-page executive overview covering business performance, marketing analytics, the lead generation funnel, product usage, retention/churn and a 6-month MRR forecast.

**All data is synthetic.** It is generated from a seeded model and does not represent actual SugboDoc customers, patients or billing. No production systems are used.

## Run

Requires Node 18+. There are no npm dependencies; Chart.js 4.4.1 loads from jsDelivr, so the browser needs internet access.

```sh
npm run generate   # regenerate data (seeded, deterministic) -> data/raw/*.csv + public/data/dashboard.json
npm start          # http://localhost:5173
npm test           # data-integrity + calculation tests (node:test)
```

To get a different synthetic dataset, change `SEED` in `scripts/generate.mjs`.

## Layout

| Path | Purpose |
|---|---|
| `scripts/generate.mjs` | Generator. Builds the relational tables, then derives the compact dashboard dataset from them |
| `data/raw/*.csv` | Relational tables: facilities, locations, doctors, nurses, patients, subscriptions, subscription_addons, encounters, appointments, clinical_notes, prescriptions, invoices, insurance_claims, ai_transactions, token_purchases, leads, social_metrics, website_traffic, outbound_calls, channels, social_platforms, plans, addons (git-ignored, regenerate as needed) |
| `public/data/dashboard.json` | Subscription and add-on periods plus facility-month usage aggregates, derived from the raw tables |
| `public/metrics.js` | Every metric, the churn diagnostics and the forecast. Pure functions, shared with the tests |
| `public/app.js`, `public/index.html` | Dashboard |
| `server.mjs` | Static file server for `public/` |
| `test/dashboard.test.mjs` | Checks keys, references, constraints and aggregates, plus hand-computed MRR, churn and forecast cases |

## Data model and assumptions

- **Marketing analytics:** monthly Facebook, Instagram and LinkedIn metrics: followers, new followers, impressions, likes, comments, shares and link clicks. Website sessions and page views are broken down by source (organic/direct plus each social platform). Social link clicks become website sessions from that platform, and those sessions feed the funnel. Facebook has the largest audience and engagement by design. All baselines and rates are illustrative assumptions (`SOCIAL` in the generator).
- **Lead generation funnel:** new facilities come from a simulated funnel: engaged lead → inquired → demo → free trial (14 days, assumed) → converted. Sources and their top-of-funnel volumes:
  - cold calling: calls made;
  - Facebook, Instagram, LinkedIn and website (organic/direct): site sessions from that source;
  - referral: referrals received.

  Each lead has one source. Cold calling produces the most conversions by design: moderate volume, high stage rates. Each converted lead *is* a facility, and its first subscription starts on the conversion date. The 45 pre-window facilities have no lead record. Stage dates after the end of the data are left empty and the lead is marked `open`. There is no spend data, so there is no CAC.
- **Re-subscribed** (final funnel stage) has two sources:
  - converted facilities still subscribed 90 days after converting;
  - **won-back** leads that dropped after inquiring (no demo, no trial, or not converted after the trial) and came back 1–5 months later to subscribe. The win-back probability rises the further the lead got, assumed at 10% / 15% / 25%.

  Won-back leads become facilities exactly like converted ones. Conversions less than 90 days old ("too recent to tell") and leads still in progress are not drawn in the Sankey; their counts appear in its description.

- **Window:** 24 consecutive months, Month 1 = Oct 2024 through Month 24 = Sep 2026. About 45 facilities onboarded before Month 1 form the starting base. Their activity records begin at Month 1.
- **Facilities** are the commercial accounts. Subscriptions, add-ons and token purchases belong to facilities. Locations/branches belong to a facility and are never counted as customers.
- **Doctors** each belong to one facility and may work at any of its locations. **Nurses/midwives** belong to a facility; `assigned_doctor_id` can be null. **Patients** are scoped to a facility. Each encounter has a patient, a doctor, a location and an optional nurse.
- **Encounter categories:** OPD / IPD / ER / OTHER. ER appears only at clinics flagged `offers_er`. For birthing homes, `maternity_service` (prenatal, delivery, postnatal, general) is recorded as a separate attribute; deliveries are IPD. These are modelling assumptions, not confirmed SugboDoc enums.
- **Subscription periods** cover `[start_date, end_date)`. Plan changes close one period and open the next on the same day (`upgrade`/`downgrade`). Only a facility's final period can end as `cancelled`. Cancellations take effect on the 1st of a month. Annual subscribers can cancel only at term end. Churned facilities do not return (win-backs are not modelled).
- **Prices:** plan list prices from the brief. Some facilities have a 10–15% negotiated discount, and annual billing takes a further 20% off. Recurring add-ons are billed at list price × quantity with no annual discount (assumption). Staff and Add Branches quantities are whatever exceeds plan capacity. Upgrading Clinic Starter to Clinic Pro happens when a second doctor joins.
- **SugboDoc Token:** each bundle costs ₱336 for an assumed 50,000 tokens (bundle size not published). Facilities buy bundles when their balance runs out, and consumption never exceeds purchases. This is non-recurring revenue and is **excluded from MRR**.
- **PhilHealth claims** are assumed included in plans. Private claims require the Private Insurance Claims add-on.

### Latent structure (hidden; not exported to the dashboard)

Each facility gets size, adoption propensity, activity level, consistency, ramp speed, instability, perceived value (a drifting random walk), retention tendency, price sensitivity and growth. These traits drive staff counts, how much of the facility's work is captured in SugboDoc, module adoption, active days, plan fit, and the monthly cancellation hazard.

**Design assumption (leakage note):** the cancellation hazard rises when *perceived value* is low and during *operational shocks*. Both of these also reduce recorded activity. That shared cause is the only route from engagement to churn. The cancellation outcome is never used to shape activity. A usage-independent closure hazard and a lognormal retention tendency produce high-usage churners and low-usage stayers, so the overlap is real. The dashboard's diagnostics use observable records only.

## Metric definitions

| Metric | Definition |
|---|---|
| Active subscribed facility | Has a subscription period covering the last day of the month |
| MRR | At month end: Σ plan list price × (1 − discount) × (0.8 if annual), plus Σ recurring add-on price × quantity. Tokens are excluded |
| New facilities | First-ever subscription starts in the period |
| Churn rate | Cancellations in month m ÷ facilities subscribed at the end of m−1. Over a period: Σ cancellations ÷ Σ opening bases. Plan changes are not churn |
| Monthly active facility | At least 1 encounter recorded in the calendar month |
| Encounters | Encounter records dated in the period |
| Appointment rates | Completed / cancelled / no-show ÷ all appointments, counting only facility-months that use the appointments module |
| Active doctors | Rostered doctors with at least 1 encounter in the month |
| Module adoption / breadth | At least 1 record in the module during the month. Breadth = how many of the 7 modules were used |
| Usage intensity | Normalised per rostered doctor; medians over facility-months |
| Retention comparisons | Churned = cancelled in Months 1–24. Retained = subscribed at end of Month 24. Per-facility monthly averages, then medians. These are associations only |
| Lead funnel | Cohort = leads whose first engagement falls in the period, followed to the end of the data. Counted at every stage reached. Volume → lead = engaged leads ÷ top-of-funnel volume. Lead → customer = converted ÷ engaged. Re-subscribed rate = still subscribed at +90 days ÷ conversions with 90 days of follow-up. Funnel conversions are counted by engagement date, so they differ from "New facilities", which counts subscription start dates |
| Marketing analytics | Engagements = likes + comments + shares. Engagement rate = engagements ÷ impressions. Website sessions are split by source. Top-of-funnel volume is in each channel's own unit (calls, sessions, referrals), so it is never summed across channels |
| Zero vs. n/a | A subscribed facility-month with no activity is 0. Months with no subscription have no row and are excluded from usage denominators. Metrics without a valid base display "n/a" |

**Period filter:** "Last 3/6/12/24 months", ending Month 24. It drives the KPIs and the period-based charts. Comparisons use the preceding equivalent window, shown as "no prior period" when that window falls outside the data. Two exceptions always use the full 24 months: the MRR chart (it shows the whole history) and the retention diagnostics (they need the sample size).

## MRR forecast

The chart has one forecast line, built with a train/test split:

1. **Train:** fit a least-squares linear trend to Months 9–20, the 12 months before the forecast origin.
2. **Project:** start from the Month 20 value, F(20+h) = MRR₂₀ + slope·h, for Months 21–30. The dotted line leaves the solid actuals at Month 20.
3. **Test:** compare Months 21–24 with the actuals, which the model never saw. The chart description reports the MAPE.
4. **Forecast:** Months 25–30 are the forward forecast.
5. **Band:** an 80% interval of ±1.2816·σ·√h, where σ is the standard deviation of month-over-month changes around the trend. All values are floored at ₱0.

Because the input is synthetic, this is not a business prediction.

## Scope notes

Out of scope by design: a predictive churn model, risk scores, AI recommendations, multiple pages, authentication and databases.

Also not included:
- Unique patients across a multi-month period. Usage is aggregated per facility-month, so the dashboard reports unique patients for the latest month only.
- Payment and collection records, since MRR comes from subscription state.
