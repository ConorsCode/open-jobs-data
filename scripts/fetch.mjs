#!/usr/bin/env node
// Standalone, zero-dependency fetcher for the open-jobs-data dataset.
//
// Reads companies.json (a fixed, curated list of companies + their ATS platform
// and slug/board URL), fetches each company's public job postings feed, and
// normalizes everything into one schema. Writes data/jobs.json, data/jobs.csv,
// and data/summary.json.
//
// This is intentionally narrow: it only works for the platforms and companies
// listed in companies.json. It does not auto-detect a company's ATS, does not
// dedupe across platforms, and does not accept an arbitrary company list at
// runtime. For that, see the paid Apify actor linked in the README.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const CONCURRENCY = 5;
const REQUEST_DELAY_MS = 150;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;
const FETCH_TIMEOUT_MS = 20000;
const USER_AGENT = 'open-jobs-data/1.0 (+https://github.com/) polite-bot';

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

// NOTE: the abort timeout must stay armed until the response body has been
// fully read, not just until headers arrive. fetch() resolving only means
// headers are in; the body is read lazily via res.text(), and if we clear the
// timeout as soon as fetch() resolves, that body read has no timeout
// protection at all and can hang forever on a stalled connection. So we read
// the body *inside* the try block, still under the same AbortController, and
// only clear the timeout once that's done (success or failure).
async function fetchWithRetryText(url, options = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        ...options,
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json,text/xml,*/*', ...(options.headers || {}) },
      });
      // Some platforms (Personio, BambooHR) 302 to a marketing page for an
      // unknown/inactive slug instead of returning a real 404.
      if (res.status >= 300 && res.status < 400) {
        clearTimeout(timeout);
        return { notFound: true, status: res.status };
      }
      if (res.status === 404 || res.status === 422) {
        clearTimeout(timeout);
        return { notFound: true, status: res.status };
      }
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) {
        clearTimeout(timeout);
        return { notFound: true, status: res.status };
      }
      const text = await res.text();
      clearTimeout(timeout);
      return { text };
    } catch (err) {
      clearTimeout(timeout);
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        const backoff = RETRY_BASE_MS * 2 ** attempt + Math.random() * 200;
        await sleep(backoff);
        continue;
      }
    }
  }
  throw lastErr ?? new Error('fetch failed');
}

async function getJson(url) {
  const { text, notFound, status } = await fetchWithRetryText(url);
  if (notFound) return { notFound: true, status };
  try {
    return { data: JSON.parse(text) };
  } catch {
    return { notFound: true, status: 'bad-json' };
  }
}

async function getText(url) {
  const { text, notFound, status } = await fetchWithRetryText(url);
  if (notFound) return { notFound: true, status };
  return { data: text };
}

async function postJson(url, body) {
  const { text, notFound, status } = await fetchWithRetryText(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (notFound) return { notFound: true, status };
  try {
    return { data: JSON.parse(text) };
  } catch {
    return { notFound: true, status: 'bad-json' };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Small shared utilities (mirrors the paid actor's logic, reimplemented)
// ---------------------------------------------------------------------------

function detectRemote(locations, explicit) {
  if (typeof explicit === 'boolean') return explicit;
  if (locations.some((l) => /remote/i.test(l))) return true;
  return null;
}

function stripHtml(html) {
  if (!html) return null;
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function nowIso() {
  return new Date().toISOString();
}

function baseJob(overrides) {
  return {
    company: null,
    platform: null,
    jobId: null,
    title: null,
    department: null,
    locations: [],
    isRemote: null,
    employmentType: null,
    applyUrl: null,
    postedAt: null,
    scrapedAt: nowIso(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Platform fetchers — each returns { jobs, notFound, error }
// ---------------------------------------------------------------------------

const platforms = {
  async greenhouse(company) {
    const slug = company.slug;
    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=false`;
    const { data, notFound } = await getJson(url);
    if (notFound) return { jobs: [], notFound: true };
    return {
      jobs: (data.jobs ?? []).map((job) => {
        const locations = job.location?.name ? [job.location.name] : [];
        return baseJob({
          company: company.name,
          platform: 'greenhouse',
          jobId: String(job.id),
          title: job.title,
          department: job.departments?.[0]?.name ?? null,
          locations,
          isRemote: detectRemote(locations),
          employmentType: null,
          applyUrl: job.absolute_url,
          postedAt: job.first_published ?? null,
        });
      }),
    };
  },

  async lever(company) {
    const slug = company.slug;
    const url = `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;
    const { data, notFound } = await getJson(url);
    if (notFound) return { jobs: [], notFound: true };
    if (!Array.isArray(data)) return { jobs: [], notFound: true };
    return {
      jobs: data.map((job) => {
        const locations = job.categories?.allLocations?.length
          ? job.categories.allLocations
          : job.categories?.location
          ? [job.categories.location]
          : [];
        const workplaceRemote =
          job.workplaceType === 'remote' ? true : job.workplaceType === 'on-site' ? false : null;
        return baseJob({
          company: company.name,
          platform: 'lever',
          jobId: job.id,
          title: job.text,
          department: job.categories?.department ?? null,
          locations,
          isRemote: detectRemote(locations, workplaceRemote),
          employmentType: job.categories?.commitment ?? null,
          applyUrl: job.applyUrl ?? job.hostedUrl,
          postedAt: job.createdAt ? new Date(job.createdAt).toISOString() : null,
        });
      }),
    };
  },

  async ashby(company) {
    const slug = company.slug;
    const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`;
    const { data, notFound } = await getJson(url);
    if (notFound) return { jobs: [], notFound: true };
    return {
      jobs: (data.jobs ?? []).map((job) => {
        const locations = [
          ...(job.location ? [job.location] : []),
          ...(job.secondaryLocations?.map((l) => l.location) ?? []),
        ];
        return baseJob({
          company: company.name,
          platform: 'ashby',
          jobId: job.id,
          title: job.title.trim(),
          department: job.department ?? null,
          locations,
          isRemote: detectRemote(locations, job.isRemote ?? null),
          employmentType: job.employmentType ?? null,
          applyUrl: job.applyUrl ?? job.jobUrl,
          postedAt: job.publishedAt ?? null,
        });
      }),
    };
  },

  async workday(company) {
    const { tenant, site, shard } = company.workday ?? {};
    if (!tenant || !site || !shard) return { jobs: [], notFound: true };
    const baseUrl = `https://${tenant}.${shard}.myworkdayjobs.com/wday/cxs/${tenant}/${site}`;
    const PAGE_SIZE = 20;
    const MAX_JOBS = 500;
    const postings = [];
    let offset = 0;
    let total = Infinity;
    while (offset < total && postings.length < MAX_JOBS) {
      const limit = Math.min(PAGE_SIZE, MAX_JOBS - postings.length);
      const { data, notFound } = await postJson(`${baseUrl}/jobs`, { limit, offset, searchText: '' });
      if (notFound) {
        if (offset === 0) return { jobs: [], notFound: true };
        break;
      }
      if (offset === 0) total = data.total ?? 0;
      if (!data.jobPostings || data.jobPostings.length === 0) break;
      postings.push(...data.jobPostings);
      offset += data.jobPostings.length;
      await sleep(REQUEST_DELAY_MS);
    }
    return {
      jobs: postings.map((posting) => {
        const locations = posting.locationsText ? [posting.locationsText] : [];
        const explicitRemote =
          posting.remoteType === 'Remote' ? true : posting.remoteType === 'On-Site' || posting.remoteType === 'Onsite' ? false : null;
        return baseJob({
          company: company.name,
          platform: 'workday',
          jobId: posting.externalPath,
          title: posting.title,
          department: null,
          locations,
          isRemote: detectRemote(locations, explicitRemote),
          employmentType: posting.timeType ?? null,
          applyUrl: `https://${tenant}.${shard}.myworkdayjobs.com/${site}${posting.externalPath}`,
          postedAt: null,
        });
      }),
    };
  },

  async smartrecruiters(company) {
    const slug = company.slug;
    const PAGE_SIZE = 100;
    const MAX_JOBS = 500;
    const jobs = [];
    let offset = 0;
    let totalFound = Infinity;
    while (offset < totalFound && jobs.length < MAX_JOBS) {
      const limit = Math.min(PAGE_SIZE, MAX_JOBS - jobs.length);
      const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=${limit}&offset=${offset}`;
      const { data, notFound } = await getJson(url);
      if (notFound) {
        if (offset === 0) return { jobs: [], notFound: true };
        break;
      }
      totalFound = data.totalFound ?? 0;
      if (!data.content || data.content.length === 0) break;
      jobs.push(...data.content);
      offset += data.content.length;
      await sleep(REQUEST_DELAY_MS);
    }
    return {
      jobs: jobs.map((job) => {
        const locations = job.location?.fullLocation ? [job.location.fullLocation] : [];
        return baseJob({
          company: company.name,
          platform: 'smartrecruiters',
          jobId: job.id,
          title: job.name,
          department: job.department?.label ?? job.function?.label ?? null,
          locations,
          isRemote: detectRemote(locations, job.location?.remote ?? null),
          employmentType: job.typeOfEmployment?.label ?? null,
          applyUrl: `https://jobs.smartrecruiters.com/${encodeURIComponent(job.company?.identifier ?? slug)}/${job.id}`,
          postedAt: job.releasedDate ?? null,
        });
      }),
    };
  },

  async workable(company) {
    const slug = company.slug;
    const url = `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=false`;
    const { data, notFound } = await getJson(url);
    if (notFound) return { jobs: [], notFound: true };
    return {
      jobs: (data.jobs ?? []).map((job) => {
        const locations = [job.city, job.state, job.country].filter(Boolean);
        return baseJob({
          company: company.name,
          platform: 'workable',
          jobId: job.shortcode,
          title: job.title,
          department: job.department ?? null,
          locations,
          isRemote: detectRemote(locations, job.telecommuting ?? null),
          employmentType: job.employment_type ?? null,
          applyUrl: job.application_url ?? job.shortlink ?? job.url ?? `https://apply.workable.com/j/${job.shortcode}`,
          postedAt: job.published_on ?? null,
        });
      }),
    };
  },

  async recruitee(company) {
    const slug = company.slug;
    const url = `https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`;
    const { data, notFound } = await getJson(url);
    if (notFound) return { jobs: [], notFound: true };
    return {
      jobs: (data.offers ?? []).map((offer) => {
        const locations = offer.locations?.length
          ? offer.locations.map((l) => l.name).filter(Boolean)
          : offer.location
          ? [offer.location]
          : [];
        const explicitRemote = offer.remote === true ? true : offer.hybrid === true ? null : offer.remote === false ? false : null;
        return baseJob({
          company: company.name,
          platform: 'recruitee',
          jobId: String(offer.id),
          title: offer.title,
          department: offer.department ?? null,
          locations,
          isRemote: detectRemote(locations, explicitRemote),
          employmentType: offer.employment_type_code ?? null,
          applyUrl: offer.careers_url,
          postedAt: offer.published_at ?? null,
        });
      }),
    };
  },

  async personio(company) {
    const slug = company.slug;
    const url = `https://${encodeURIComponent(slug)}.jobs.personio.de/xml`;
    const { data: xml, notFound } = await getText(url);
    if (notFound || !xml || !xml.includes('<position>')) return { jobs: [], notFound: true };
    const positions = parsePersonioXml(xml);
    return {
      jobs: positions.map((position) =>
        baseJob({
          company: company.name,
          platform: 'personio',
          jobId: position.id,
          title: position.name,
          department: position.department,
          locations: position.locations,
          isRemote: detectRemote(position.locations),
          employmentType: position.employmentType,
          applyUrl: `https://${slug}.jobs.personio.de/job/${position.id}`,
          postedAt: position.createdAt,
        })
      ),
    };
  },

  async bamboohr(company) {
    const slug = company.slug;
    const url = `https://${encodeURIComponent(slug)}.bamboohr.com/careers/list`;
    const { data: body, notFound } = await getText(url);
    if (notFound) return { jobs: [], notFound: true };
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return { jobs: [], notFound: true };
    }
    if (!Array.isArray(data.result)) return { jobs: [], notFound: true };
    return {
      jobs: data.result.map((job) => {
        const location = job.location ?? {};
        const atsLocation = job.atsLocation ?? {};
        const locations = [location.city, location.state, atsLocation.city, atsLocation.province, atsLocation.state, atsLocation.country]
          .filter((v, i, all) => Boolean(v) && all.indexOf(v) === i);
        return baseJob({
          company: company.name,
          platform: 'bamboohr',
          jobId: job.id,
          title: job.jobOpeningName.trim(),
          department: job.departmentLabel ?? null,
          locations,
          isRemote: detectRemote(locations, job.isRemote ?? null),
          employmentType: job.employmentStatusLabel ?? null,
          applyUrl: `https://${slug}.bamboohr.com/careers/${job.id}`,
          postedAt: null,
        });
      }),
    };
  },
};

function parsePersonioXml(xml) {
  const positions = [];
  const blocks = xml.match(/<position>[\s\S]*?<\/position>/g) ?? [];
  for (const block of blocks) {
    const id = matchTag(block, 'id');
    const name = matchTag(block, 'name');
    if (!id || !name) continue;
    const officeValues = [...block.matchAll(/<office>([\s\S]*?)<\/office>/g)].map((m) => m[1].trim());
    const locations = officeValues.flatMap((v) => v.split(',')).map((p) => p.trim()).filter(Boolean);
    positions.push({
      id,
      name: decodeEntities(name).trim(),
      department: matchTag(block, 'department'),
      employmentType: matchTag(block, 'employmentType'),
      locations,
      createdAt: matchTag(block, 'createdAt'),
    });
  }
  return positions;
}

function matchTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  if (!m) return null;
  const value = decodeEntities(m[1]).trim();
  return value.length > 0 ? value : null;
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

// ---------------------------------------------------------------------------
// Runner: bounded concurrency over companies.json, never let one failure sink the run
// ---------------------------------------------------------------------------

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
      await sleep(REQUEST_DELAY_MS);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

function toCsv(rows) {
  const headers = ['company', 'platform', 'jobId', 'title', 'department', 'locations', 'isRemote', 'employmentType', 'applyUrl', 'postedAt', 'scrapedAt'];
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = Array.isArray(v) ? v.join('; ') : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(','));
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const companiesRaw = await readFile(path.join(ROOT, 'companies.json'), 'utf8');
  const companies = JSON.parse(companiesRaw);

  console.log(`Fetching ${companies.length} companies across ${new Set(companies.map((c) => c.platform)).size} platforms...`);

  const startedAt = Date.now();
  const perCompanyStatus = [];

  const results = await mapWithConcurrency(companies, CONCURRENCY, async (company) => {
    const fetcher = platforms[company.platform];
    if (!fetcher) {
      perCompanyStatus.push({ company: company.name, platform: company.platform, status: 'unsupported-platform', jobs: 0 });
      return [];
    }
    try {
      const { jobs, notFound } = await fetcher(company);
      if (notFound) {
        perCompanyStatus.push({ company: company.name, platform: company.platform, status: 'not-found', jobs: 0 });
        return [];
      }
      perCompanyStatus.push({ company: company.name, platform: company.platform, status: 'ok', jobs: jobs.length });
      return jobs;
    } catch (err) {
      perCompanyStatus.push({ company: company.name, platform: company.platform, status: `error: ${err.message}`, jobs: 0 });
      return [];
    }
  });

  const allJobs = results.flat();
  const elapsedMs = Date.now() - startedAt;

  await mkdir(path.join(ROOT, 'data'), { recursive: true });

  await writeFile(path.join(ROOT, 'data', 'jobs.json'), JSON.stringify(allJobs, null, 2) + '\n');
  await writeFile(path.join(ROOT, 'data', 'jobs.csv'), toCsv(allJobs));

  const byPlatform = {};
  const byCompany = {};
  for (const job of allJobs) {
    byPlatform[job.platform] = (byPlatform[job.platform] ?? 0) + 1;
    byCompany[job.company] = (byCompany[job.company] ?? 0) + 1;
  }

  const summary = {
    generatedAt: nowIso(),
    total: allJobs.length,
    byPlatform,
    byCompany,
    companiesAttempted: companies.length,
    companiesOk: perCompanyStatus.filter((s) => s.status === 'ok').length,
    companiesFailed: perCompanyStatus.filter((s) => s.status !== 'ok').length,
    elapsedMs,
    perCompanyStatus,
  };
  await writeFile(path.join(ROOT, 'data', 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

  console.log(`Done in ${(elapsedMs / 1000).toFixed(1)}s. Total jobs: ${allJobs.length}`);
  console.log('By platform:', byPlatform);
  console.log(`Companies ok: ${summary.companiesOk}/${summary.companiesAttempted}`);
  const failed = perCompanyStatus.filter((s) => s.status !== 'ok');
  if (failed.length) {
    console.log('Failed/empty companies:', failed.map((f) => `${f.company}(${f.platform}):${f.status}`).join(', '));
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
