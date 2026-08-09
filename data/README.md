# data/

This directory holds the current snapshot of the dataset, regenerated daily by
`.github/workflows/update.yml` running `scripts/fetch.mjs`.

## Files

- `jobs.json` — every open posting, as a JSON array.
- `jobs.csv` — the same data as CSV (array fields like `locations` are joined with `; `).
- `new-jobs.json` — postings that appeared since the previous snapshot. Same schema as
  `jobs.json`, plus a `firstSeenAt` field. See "What 'new' means" below.
- `new-jobs.xml` — the same postings as an RSS 2.0 feed, for use in a feed reader.
- `summary.json` — counts by platform and by company, total row count, run duration,
  new-since-last-snapshot count, and a per-company status list (useful for spotting a
  company that dropped out or an ATS that changed shape).

## What "new" means (read this before relying on new-jobs.json/xml)

Every run of `scripts/fetch.mjs` reads the *previous* `data/jobs.json` off disk before
overwriting it, and diffs the new results against it by `(platform, jobId)`.

**"New" means "this posting was not present in yesterday's snapshot" — it does NOT mean
"posted today."** Two different things can put a job in `new-jobs.json`:

1. The company genuinely just opened the role.
2. The role already existed, but our tracked company list changed (a company was newly
   added to `companies.json`) and this is the first snapshot that includes it.

To keep case 2 from flooding the feed with a company's entire back-catalog of open roles
on the day it's added, **jobs from a company that had zero presence in the previous
snapshot are excluded from `new-jobs.json`/`new-jobs.xml` entirely** — only genuinely new
postings from already-tracked companies are counted as "new." (You can still see a newly
added company's full job list in `jobs.json` as usual; it just won't show up in the "new"
feed on day one.)

On the very first run of this script (no previous `data/jobs.json` on disk — e.g. a fresh
clone with no prior history), there is nothing to diff against, so `new-jobs.json` and
`new-jobs.xml` are emitted empty and `summary.json`'s `newSinceLastSnapshotFirstRun` is
`true`. This is a "we don't know yet" state, not a claim that zero jobs are new.

`summary.json` records `previousSnapshotAt` (the `generatedAt` of the snapshot that was
diffed against) so consumers can show the actual window "new" covers — which may be
longer than 24 hours if a run was skipped or failed.

## Schema

Every row, regardless of source platform, has this shape:

| Field | Type | Notes |
|---|---|---|
| `company` | string | Display name from `companies.json` |
| `platform` | string | One of `greenhouse`, `lever`, `ashby`, `workday`, `smartrecruiters`, `workable`, `recruitee`, `personio`, `bamboohr` |
| `jobId` | string | Platform-native posting ID |
| `title` | string | Job title, as published |
| `department` | string \| null | Not exposed by every platform |
| `locations` | array of strings | All listed locations for the posting |
| `isRemote` | boolean \| null | Platform's own remote flag when present, else inferred from location text containing "remote"; `null` when neither is available |
| `employmentType` | string \| null | e.g. "Full-time" — not exposed by every platform |
| `applyUrl` | string | Direct link to the live application page |
| `postedAt` | string \| null | ISO timestamp when the platform reports one (always `null` for Workday and BambooHR) |
| `scrapedAt` | string | ISO timestamp of this fetch |

`new-jobs.json` rows have one additional field: `firstSeenAt` (string, ISO timestamp of
the run that first observed this posting).

See the top-level README for known limitations of each platform.
