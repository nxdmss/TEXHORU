# TEXHORU · ускоренная первая привязка (November 2026)

This optimization applies to the **first** 1C → competitor discovery/matching run.
It does **not** relax the exact-variant check or change prices in 1C.

- **05.ru category index:** persist URL/title/model hints once, reuse by all 1C variants.
  A completed (<=7 days old) index suppresses an otherwise redundant 50-page
  in-memory category crawl inside EACH live search. Live store search still runs
  if the index did not produce a suitable match.
- **Read-once page cache:** during initial matching, verified 05.ru product-page
  observations are reused for three minutes (maximum 600 URLs). Concurrent
  requests for the same URL share the first read. Failed pages are not cached.
  **Scheduled six-hour monitor always uses parse(), which fetches live pages.**
- **One database ownership read:** check candidate ownership as a group rather
  than one query per each of the eight local index candidates.
- **Adaptive smartphone lookup:** exit the query fallback sequence only when
  two distinct successful, nonpartial searches independently return the **same
  one** full-identity, conflict-free exact URL. No clear answer, ambiguity, or
  partial search: keep exploring the remaining queries. Multiple exact URLs
  always go to manual review.
- **Faster job queue:** drain the next task after 100 ms rather than waiting for
  the one-second idle poll. The worker still runs one job at a time.
- **Unchanged safeguards:** 403/429 responses pause the job, only confirmed
  links are polled for updated prices, no auto-writing site or 1C prices.

## How to evaluate speed

Run the same selection of 100 in-stock 1C items on a **test instance**, compare
wall-clock time, confirmed matches, manual reviews, technical errors, and 05.ru
requests against the previous version. A short-lived cache makes later runs
faster, so cold-start and warm-start times must be measured separately.
This change was tested with automated stubs, not validated on the live stores.
