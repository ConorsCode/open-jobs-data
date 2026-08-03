# data/

This directory holds the current snapshot of the dataset, regenerated daily by
`.github/workflows/update.yml` running `scripts/fetch.mjs`.

## Files

- `jobs.json` — every open posting, as a JSON array.
- `jobs.csv` — the same data as CSV (array fields like `locations` are joined with `; `).
- `summary.json` — counts by platform and by company, total row count, run duration, and
  a per-company status list (useful for spotting a company that dropped out or an ATS
  that changed shape).

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

See the top-level README for known limitations of each platform.
