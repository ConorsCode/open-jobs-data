# open-jobs-data

A free, daily-updated dataset of open job postings from ~380 well-known tech
companies, pulled directly from nine applicant tracking systems (ATS) and
normalized into one schema.

Current snapshot: **37,180 postings** across 378 companies (last full run:
2026-08-06, ~102s). Numbers move daily as postings open and close — see
`data/summary.json` for the current count.

Data lives in [`data/`](data/):

- [`data/jobs.json`](data/jobs.json) — every posting, as JSON
- [`data/jobs.csv`](data/jobs.csv) — same data as CSV
- [`data/summary.json`](data/summary.json) — counts by platform/company, run stats
- [`data/README.md`](data/README.md) — schema doc

A GitHub Actions workflow (`.github/workflows/update.yml`) re-runs the fetcher
every day and commits whatever changed. No manual updates.

## Why this exists

Most companies with a real hiring pipeline publish their open roles through a
public, unauthenticated JSON (or XML) feed on their ATS — Greenhouse, Lever,
Ashby, and so on. These feeds are what each platform's own embeddable careers
widget uses, so they're stable and meant to be read programmatically. This
repo just fetches ~380 of them daily, normalizes the output, and commits it, so
you don't have to write nine different parsers to get one CSV of open roles.

## Schema

| Field | Type | Notes |
|---|---|---|
| `company` | string | Display name |
| `platform` | string | `greenhouse`, `lever`, `ashby`, `workday`, `smartrecruiters`, `workable`, `recruitee`, `personio`, or `bamboohr` |
| `jobId` | string | Platform-native posting ID |
| `title` | string | Job title, as published |
| `department` | string \| null | Not exposed by every platform |
| `locations` | array of strings | All listed locations |
| `isRemote` | boolean \| null | Platform's own remote flag when present, else inferred from location text; `null` if neither is available |
| `employmentType` | string \| null | e.g. "Full-time" — not exposed by every platform |
| `applyUrl` | string | Direct link to the application page |
| `postedAt` | string \| null | ISO timestamp, when the platform reports one |
| `scrapedAt` | string | ISO timestamp of the fetch that produced this row |

### Sample row (from the live run above)

```json
{
  "company": "Ramp",
  "platform": "ashby",
  "jobId": "34413f8d-26bf-4bbc-8ade-eb309a0e2245",
  "title": "Security Engineer, Cloud",
  "department": "Engineering",
  "locations": ["New York, NY (HQ)", "Remote (Canada)", "Remote (US)", "Miami, FL"],
  "isRemote": true,
  "employmentType": "FullTime",
  "applyUrl": "https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245/application",
  "postedAt": "2026-04-07T17:12:35.753+00:00",
  "scrapedAt": "2026-08-06T00:57:02.932Z"
}
```

## Using the data

### curl

```bash
curl -s https://raw.githubusercontent.com/ConorsCode/open-jobs-data/main/data/jobs.json | jq '.[0]'
```

### pandas

```python
import pandas as pd
df = pd.read_json("https://raw.githubusercontent.com/ConorsCode/open-jobs-data/main/data/jobs.json")
df[df["isRemote"] == True].groupby("company").size().sort_values(ascending=False)
```

### JavaScript

```js
const jobs = await fetch(
  "https://raw.githubusercontent.com/ConorsCode/open-jobs-data/main/data/jobs.json"
).then((r) => r.json());

const remote = jobs.filter((j) => j.isRemote);
console.log(`${remote.length} remote postings`);
```

## Coverage

378 companies as of the current snapshot, spanning all nine platforms below.
Actual counts shift as feeds change — `data/summary.json` has the live
breakdown.

| Platform | Endpoint used | Companies in this run |
|---|---|---|
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{slug}/jobs` | 263 |
| Lever | `api.lever.co/v0/postings/{slug}` | 11 |
| Ashby | `api.ashbyhq.com/posting-api/job-board/{slug}` | 71 |
| SmartRecruiters | `api.smartrecruiters.com/v1/companies/{slug}/postings` | 6 |
| Workable | `apply.workable.com/api/v1/widget/accounts/{slug}` | 4 |
| Recruitee | `{slug}.recruitee.com/api/offers/` | 5 |
| Personio | `{slug}.jobs.personio.de/xml` | 6 |
| BambooHR | `{slug}.bamboohr.com/careers/list` | 2 |
| Workday | `{tenant}.{shard}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` | 10 |

The full list, including the exact slug/board details used, is in
[`companies.json`](companies.json).

### Proposing an addition

Open a PR that adds an entry to `companies.json`. It needs a `name`, a
`platform` (one of the nine above), and either a `slug` (for the
bare-slug platforms) or a `workday` object with `tenant`, `site`, and
`shard` (Workday board URLs don't follow a guessable pattern, so paste the
tenant/site/shard from the company's actual board URL, e.g.
`https://intel.wd1.myworkdayjobs.com/External` → tenant `intel`, site
`External`, shard `wd1`).

Before opening the PR, confirm the endpoint actually returns postings —
run `node scripts/fetch.mjs` locally after adding the entry and check
`data/summary.json`'s `perCompanyStatus` for your addition. Entries that
come back empty or `not-found` will be reverted.

Companies are added on a rolling basis; there's no fixed cap, but each
addition should be a real, well-known company with an active public feed,
not a personal test account or an aggregator.

## Limitations (read before relying on this for anything important)

- **Only public, unauthenticated feeds.** No login-gated boards, no
  scraping of rendered HTML, no LinkedIn-only postings, no custom in-house
  career pages that don't run one of these nine ATSes.
- **No job descriptions.** This dataset only pulls title/location/metadata
  fields, not the full posting body, to keep the daily fetch fast, cheap,
  and low-load on each platform.
- **Snapshot timing.** Each row reflects the moment `scrapedAt` records —
  postings can close or change within minutes of that. Don't treat a
  27-hour-old row as still open without checking `applyUrl`.
- **`postedAt` is always `null` for Workday and BambooHR.** Neither
  platform's list endpoint exposes a real timestamp for it.
- **`isRemote` is best-effort.** It uses each platform's own remote flag
  when present, otherwise infers from location text containing "remote" —
  this can misclassify unusual location strings.
- **An empty platform result for a company doesn't always mean "gone."**
  Some platforms (Lever, Ashby, SmartRecruiters) return an empty list both
  when a company has zero current openings and, if the slug ever changed,
  when it's genuinely not found. `data/summary.json` records the raw
  per-company status so you can tell the two apart over time.
- **No personal data.** This dataset only contains what each ATS publishes
  about the *job*, never applicant data.
- **Fixed company list, refreshed daily.** This repo does not accept an
  arbitrary company list at request time — see below if you need that.

## If you need this for your own company list

This repo's fetcher (`scripts/fetch.mjs`) is deliberately narrow: it's a
compact, dependency-free script that only runs against the fixed list in
`companies.json`, once a day, via GitHub Actions. That's what keeps it free
and easy to audit.

If you want the same nine-platform normalization run against **your own**
list of companies — with auto-detection of which ATS a bare company name
uses, dedup across platforms when a company is findable on more than one,
a per-company status report, and hosted execution so you don't run your own
cron — that's a separate, paid tool: the
[ATS Jobs Scraper on Apify](https://apify.com/studious_allergy_mig/ats-jobs-scraper).
It's pay-per-result (one result = one job posting) and covers the same nine
platforms as this repo, plus optional full job descriptions.

This repo and that actor share no code — the actor is a proper TypeScript
project with input validation, retries tuned per platform, and support; this
repo is ~500 lines of plain Node meant to be read in one sitting.

## License

MIT — see [`LICENSE`](LICENSE). The code is MIT licensed; the job posting
data itself is republished from each company's own public feed and belongs
to the respective employer.

## Related open datasets

Part of a small set of free, daily-refreshed datasets built the same way:
zero-dependency Node fetcher, GitHub Actions refresh, public endpoints only.

- **[Open FedSpend Data](https://github.com/ConorsCode/open-fedspend-data)** — 28,092 recent US federal contract awards from USAspending.gov, with recipient and agency aggregates.
- **[Open Dependency Risk](https://github.com/ConorsCode/open-dependency-risk)** — 1,500 widely-used npm and PyPI packages joined with known vulnerabilities from OSV.dev.
