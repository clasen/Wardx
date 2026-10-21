# Ad campaign attribution for a website

Use this when ads bring people to a website served by a Node backend, they start
a trial (for example a desktop app download) and buy later through a payment
webhook on the same backend. The full worked example, with code, is the Node
SDK README's use case 17. This page is the checklist an agent follows while
integrating it. It needs no Wardx changes.

## Identity and project

- The `userId` is an anonymous visitor ID in a first-party cookie (random UUID,
  about 90 days). Never use an email, an account ID or an ad click ID.
- Use a separate Wardx project for the website (for example `shop-web`) with a
  `backend` credential. Do not reuse an app's retention project: one project has
  one activity definition and one user capacity.
- Keep `privacySalt` stable forever; a changed salt is rejected.

## Channel

- Map campaign parameters through a closed list to a few labels: `utm_source`
  first, then `fbclid` → `meta`, `gclid`/`gbraid`/`wbraid` → `google`, unknown
  sources → `other`, nothing → `organic`. Labels match
  `^[a-z0-9][a-z0-9._-]{0,63}$`.
- Always pass a channel, including `organic`, so the first activity fixes it
  (strict first touch). Store it in a cookie on the first visit so later
  requests, such as the download, carry the same channel.
- Never put campaign, ad set or creative IDs in the channel. Count those, if
  needed, on a counter dimension with a bounded list.

## Cohort entry

- Call `retentionActivity(visitorId, { channel })` on the trial start (the
  download), not on every page view. It keeps bots and window-shoppers out of
  the cohort, aligns D7 with a 7-day trial, and turns a purchase from another
  browser into an orphan conversion instead of an `organic` cohort that
  converts on D0.
- Filter obvious bots and prefetches in the backend before recording anything.
- Record at most one activity per visitor per UTC day. Every event shares the
  SDK's in-memory buffer (`maxBufferedEvents`); bursts must not drop purchases.
- Count visits and downloads with counters by channel
  (`counter('web.visitor_day', { channel })`, `counter('web.download', { channel })`).

## Conversions

- Pass the visitor ID into the checkout (Paddle `customData`, Stripe
  `metadata`). In the webhook, after verifying its signature, call
  `conversion(visitorId, 'purchase')`.
- Then `const { ok } = await wardx.flush()`. On `ok: false` answer 5xx so the
  provider retries, and mark the webhook event processed only after `ok`.
  Repeats are idempotent and appear in `duplicateConversions`.
- Purchases without a visitor ID: increment a counter.
- Refunds and chargebacks: `conversion(visitorId, 'refund')` /
  `conversion(visitorId, 'chargeback')`, resolving the visitor from the stored
  transaction, plus counters for period totals. Conversions are never reversed.
- A conversion is not activity: never call `retentionActivity` from a webhook.

## Reading

- `get_retention({ project, from, to, goal: 'purchase', byChannel: true })`.
  `conversions` is cumulative (bought on or before D_N). `returns` measures
  repeat trial starts, not app usage, because the app does not know the
  visitor; do not present it as app retention.
- Compare channels at the same cohort age, never by period sales.
- Report `orphanConversions` next to the rates, `(over_cap)` rows if any, and
  `capacity`. Warn before `capacity.users` reaches `maxUsers`: rows do not
  expire, and new visitors are dropped after that.
- Horizons are D1/D7/D30 only. For weekly cohorts, add daily rows and skip
  pending horizons.
- Net conversion per cohort is `purchase` minus `refund`, from two calls.

## Experiments

To test the landing page or the price, assign with
`config.get(key, fallback, { subjectId: visitorId })` on the backend and record
`experiment.goal('purchase', { subjectId: visitorId })` next to `conversion`.
The experiment decides the variant; the cohort measures the channel.
