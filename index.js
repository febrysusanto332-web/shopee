import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config — set these in Render's Environment Variables tab
// Supports ANY number of Threads accounts. Just add more numbered variables:
// THREADS_ACCESS_TOKEN_1 / THREADS_USER_ID_1, THREADS_ACCESS_TOKEN_2 / THREADS_USER_ID_2,
// THREADS_ACCESS_TOKEN_3 / THREADS_USER_ID_3, ... no code changes needed.
// Tools select between them via "akun_1", "akun_2", "akun_3", etc.
// ---------------------------------------------------------------------------
const GRAPH_BASE = "https://graph.threads.net/v1.0";

// Public Threads search is handled through Apify so it does not depend on
// Meta's threads_keyword_search permission / App Review. Meta API is still
// used for your own accounts (posting, insights, replies, etc.).
const APIFY_API_BASE = "https://api.apify.com/v2";
const APIFY_TOKEN = process.env.APIFY_TOKEN || "";
const APIFY_PRIMARY_ACTOR =
  process.env.APIFY_PRIMARY_ACTOR || "scrapersdelight/threads-keyword-search-scraper";
const APIFY_FALLBACK_ACTOR =
  process.env.APIFY_FALLBACK_ACTOR || "logical_scrapers/threads-search-scraper";
const APIFY_MAX_CHARGE_USD = Number(process.env.APIFY_MAX_CHARGE_USD || "0.50");

const ACCOUNTS = {};
for (let i = 1; ; i++) {
  const token = process.env[`THREADS_ACCESS_TOKEN_${i}`];
  const userId = process.env[`THREADS_USER_ID_${i}`];
  if (!token && !userId) break; // stop at the first gap in numbering
  ACCOUNTS[`akun_${i}`] = {
    label: process.env[`THREADS_ACCOUNT_${i}_LABEL`] || `Akun ${i}`,
    accessToken: token,
    userId: userId,
  };
}

const accountKeys = Object.keys(ACCOUNTS);

if (accountKeys.length === 0) {
  console.warn(
    "[WARN] No Threads accounts configured. Set THREADS_ACCESS_TOKEN_1 and " +
      "THREADS_USER_ID_1 (and _2, _3, ... for more accounts) in Render's Environment Variables."
  );
}

for (const [key, acc] of Object.entries(ACCOUNTS)) {
  if (!acc.accessToken || !acc.userId) {
    console.warn(`[WARN] Credentials for ${key} (${acc.label}) are incomplete.`);
  }
}

function getAccount(accountKey) {
  const acc = ACCOUNTS[accountKey];
  if (!acc) {
    throw new Error(`Unknown account "${accountKey}". Available: ${accountKeys.join(", ") || "(none configured)"}`);
  }
  if (!acc.accessToken || !acc.userId) {
    throw new Error(`Account "${accountKey}" (${acc.label}) is not configured with credentials yet.`);
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Small helper for calling the Threads Graph API
// ---------------------------------------------------------------------------
class ThreadsApiError extends Error {
  constructor(message, { status, data, path } = {}) {
    super(message);
    this.name = "ThreadsApiError";
    this.status = status;
    this.data = data;
    this.path = path;
  }
}

async function threadsFetch(accessToken, path, { method = "GET", params = {}, body } = {}) {
  const url = new URL(`${GRAPH_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  url.searchParams.set("access_token", accessToken ?? "");

  const res = await fetch(url.toString(), {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

  // Meta occasionally returns a 5xx with either a tiny JSON error or even an
  // empty body. Read as text first so the original error is never hidden by a
  // JSON parse failure.
  const raw = await res.text();
  let data = {};
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw };
    }
  }

  if (!res.ok) {
    const graphError = data?.error || {};
    const graphCode = graphError.code ?? "unknown";
    const graphSubcode = graphError.error_subcode ? `/${graphError.error_subcode}` : "";
    const graphMessage = graphError.message || data?.raw || res.statusText || "Unknown Threads API error";

    throw new ThreadsApiError(
      `Threads API ${res.status} (code ${graphCode}${graphSubcode}) on ${path}: ${graphMessage}`,
      { status: res.status, data, path }
    );
  }
  return data;
}

function explainThreadsError(err) {
  if (!(err instanceof ThreadsApiError)) {
    return String(err?.message || err);
  }

  const graphError = err.data?.error || {};
  const code = Number(graphError.code);
  const message = graphError.message || err.message;

  if (err.path === "/keyword_search" && (code === 1 || code === 10)) {
    return [
      `Keyword Search ditolak oleh Meta (HTTP ${err.status}, code ${code}: ${message}).`,
      "Endpoint dan parameter MCP sudah benar; error ini terjadi langsung di graph.threads.net.",
      "Periksa Meta App -> Threads API -> Permissions/Use cases: threads_keyword_search harus aktif pada app DAN scope itu harus ada pada access token yang sekarang dipakai.",
      "Jika permission baru saja diaktifkan, buat/authorize token BARU dengan threads_basic + threads_keyword_search lalu ganti THREADS_ACCESS_TOKEN_N di Render dan redeploy.",
      "Untuk mencari postingan publik milik akun lain, threads_keyword_search juga memerlukan akses/approval Meta yang sesuai (Advanced Access/App Review).",
      graphError.fbtrace_id ? `fbtrace_id: ${graphError.fbtrace_id}` : null,
    ].filter(Boolean).join("\n");
  }

  if (code === 190) {
    return `Access token Threads tidak valid/kedaluwarsa. Buat token baru, update Environment Variable di Render, lalu redeploy. Detail: ${message}`;
  }

  return err.message;
}

function mcpToolError(err) {
  return {
    isError: true,
    content: [{ type: "text", text: explainThreadsError(err) }],
  };
}

// ---------------------------------------------------------------------------
// Apify public-search helpers
// ---------------------------------------------------------------------------
class ApifyError extends Error {
  constructor(message, { status, actor, data } = {}) {
    super(message);
    this.name = "ApifyError";
    this.status = status;
    this.actor = actor;
    this.data = data;
  }
}

function actorRef(actor) {
  // Apify's REST API accepts owner~actor-name. Environment variables may use
  // the friendlier owner/actor-name format shown in the Apify Store.
  return String(actor || "").trim().replace("/", "~");
}

async function apifyRunActor(actor, input, { billingLimit = 100 } = {}) {
  if (!APIFY_TOKEN) {
    throw new ApifyError(
      "APIFY_TOKEN belum dikonfigurasi di Render. Tambahkan Environment Variable APIFY_TOKEN lalu redeploy.",
      { actor }
    );
  }

  const actorId = actorRef(actor);
  const url = new URL(`${APIFY_API_BASE}/actors/${actorId}/run-sync-get-dataset-items`);
  // Cost guardrails. maxItems is a billing cap for pay-per-result Actors.
  url.searchParams.set("maxItems", String(Math.max(1, Math.min(500, billingLimit))));
  if (Number.isFinite(APIFY_MAX_CHARGE_USD) && APIFY_MAX_CHARGE_USD > 0) {
    url.searchParams.set("maxTotalChargeUsd", String(APIFY_MAX_CHARGE_USD));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 295_000); // Apify sync max is ~300s

  let res;
  try {
    res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${APIFY_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err?.name === "AbortError") {
      throw new ApifyError(`Apify Actor ${actor} timeout setelah ~295 detik.`, { actor });
    }
    throw new ApifyError(`Gagal menghubungi Apify Actor ${actor}: ${err?.message || err}`, { actor });
  }
  clearTimeout(timeout);

  const raw = await res.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw };
    }
  }

  if (!res.ok) {
    const msg =
      data?.error?.message ||
      data?.message ||
      data?.raw ||
      res.statusText ||
      "Unknown Apify error";
    throw new ApifyError(`Apify ${res.status} pada ${actor}: ${msg}`, {
      status: res.status,
      actor,
      data,
    });
  }

  if (!Array.isArray(data)) {
    throw new ApifyError(`Actor ${actor} selesai tetapi response dataset bukan array.`, {
      status: res.status,
      actor,
      data,
    });
  }
  return data;
}

const asNumber = (...values) => {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
};

function normalizeApifyPost(item, provider) {
  const id = String(item.postId ?? item.id ?? item.pk ?? item.code ?? item.postCode ?? "");
  const url = item.postUrl ?? item.url ?? item.permalink ?? null;
  const timestamp = item.postedAt ?? item.createdAt ?? item.timestamp ?? item.takenAt ?? null;
  const username = item.authorUsername ?? item.username ?? item.author?.username ?? null;
  const fullName = item.authorFullName ?? item.fullName ?? item.author?.fullName ?? null;
  const likeCount = asNumber(item.likeCount, item.likes, item.like_count);
  const replyCount = asNumber(item.replyCount, item.replies, item.reply_count);
  const repostCount = asNumber(item.repostCount, item.reposts, item.repost_count);
  const quoteCount = asNumber(item.quoteCount, item.quotes, item.quote_count);
  const reshareCount = asNumber(item.reshareCount, item.reshares, item.reshare_count);
  const engagementTotal = asNumber(
    item.engagementTotal,
    likeCount + replyCount + repostCount + quoteCount
  );

  return {
    id,
    url,
    text: item.text ?? item.caption ?? "",
    timestamp,
    username,
    full_name: fullName,
    like_count: likeCount,
    reply_count: replyCount,
    repost_count: repostCount,
    quote_count: quoteCount,
    reshare_count: reshareCount,
    engagement_total: engagementTotal,
    is_reply: Boolean(item.isReply),
    is_quote_post: Boolean(item.isQuotePost),
    media_type: item.mediaType ?? item.media_type ?? null,
    image_url: item.imageUrl ?? (Array.isArray(item.images) ? item.images[0] : null) ?? null,
    video_url: item.videoUrl ?? (Array.isArray(item.videos) ? item.videos[0] : null) ?? null,
    author_profile_url: item.authorProfileUrl ?? item.profileUrl ?? null,
    author_verified: Boolean(item.authorIsVerified ?? item.isVerified),
    search_surface: item.searchSurface ?? item.searchType ?? null,
    source: provider,
  };
}

function dedupePosts(posts) {
  const seen = new Set();
  const out = [];
  for (const post of posts) {
    const key = post.id || post.url || `${post.username || ""}:${post.timestamp || ""}:${post.text || ""}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(post);
  }
  return out;
}

function sortPosts(posts, sortBy) {
  const now = Date.now();
  const maxEng = Math.max(1, ...posts.map((p) => asNumber(p.engagement_total)));
  const withScore = posts.map((p) => {
    const t = new Date(p.timestamp || 0).getTime();
    const ageHours = Number.isFinite(t) && t > 0 ? Math.max(0, (now - t) / 3_600_000) : 999999;
    const recencyScore = Math.exp(-ageHours / (24 * 14));
    const engagementScore = Math.log1p(asNumber(p.engagement_total)) / Math.log1p(maxEng);
    const balancedScore = 0.55 * recencyScore + 0.45 * engagementScore;
    return { ...p, _balanced_score: balancedScore };
  });

  if (sortBy === "RECENT") {
    withScore.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
  } else if (sortBy === "ENGAGEMENT") {
    withScore.sort((a, b) => b.engagement_total - a.engagement_total);
  } else {
    withScore.sort((a, b) => b._balanced_score - a._balanced_score);
  }

  return withScore.map(({ _balanced_score, ...p }) => p);
}

function dateOnly(value) {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function daysFromSince(since, fallback) {
  if (!since) return fallback;
  const d = new Date(since);
  if (Number.isNaN(d.getTime())) return fallback;
  const days = Math.ceil((Date.now() - d.getTime()) / 86_400_000);
  return Math.max(1, Math.min(3650, days));
}

async function searchWithPrimary({ query, limit, searchType, searchMode, includeReplies, minLikes, since }) {
  const fetchLimit = Math.max(limit, Math.min(100, Math.max(25, limit * 3)));
  const input = {
    keywords: [query],
    searchType: searchMode === "TAG" ? "tags" : searchType === "TOP" ? "top" : "both",
    passesPerSurface: searchType === "RECENT" ? 2 : 1,
    maxPostsPerKeyword: fetchLimit,
    maxItems: fetchLimit,
    minLikes,
    postedWithinDays: daysFromSince(since, searchType === "RECENT" ? 30 : 0),
    excludeReplies: !includeReplies,
    onlyWithLinks: false,
    requestConcurrency: 1,
    proxyConfiguration: { useApifyProxy: true },
  };
  const rows = await apifyRunActor(APIFY_PRIMARY_ACTOR, input, { billingLimit: fetchLimit });
  return rows.map((x) => normalizeApifyPost(x, "apify_primary"));
}

async function searchWithFallback({ query, limit, searchType, searchMode, includeReplies, since, until }) {
  const fetchLimit = Math.max(limit, Math.min(100, Math.max(20, limit * 2)));
  const input = {
    searchQueries: [query],
    searchType: searchMode === "TAG" ? "tags" : searchType.toLowerCase(),
    maxItems: fetchLimit,
    includeReplies,
    ...(since ? { postedAfter: dateOnly(since) } : {}),
    ...(until ? { postedBefore: dateOnly(until) } : {}),
    proxyConfiguration: { useApifyProxy: true },
  };
  const rows = await apifyRunActor(APIFY_FALLBACK_ACTOR, input, { billingLimit: fetchLimit });
  return rows.map((x) => normalizeApifyPost(x, "apify_fallback"));
}

const accountField = (accountKeys.length > 0 ? z.enum(accountKeys) : z.string())
  .default(accountKeys[0] || "akun_1")
  .describe(
    accountKeys.length > 0
      ? `Akun Threads mana yang dipakai: ${accountKeys.join(", ")}`
      : "Akun Threads mana yang dipakai (belum ada akun yang ter-konfigurasi)"
  );

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// MCP server + tools
// ---------------------------------------------------------------------------
function createServer() {
  const server = new McpServer({ name: "threads-mcp", version: "1.1.0" });

  server.registerTool(
    "search_threads",
    {
      title: "Search public Threads posts",
      description:
        "Search PUBLIC Threads posts through Apify. This does not require Meta threads_keyword_search permission. The server tries the low-cost Actor first and automatically falls back to a second Actor if the first fails or returns too few results. Use RECENT for newest, TOP for popular/relevant, and BALANCED sorting when you want a mix of freshness + engagement.",
      inputSchema: {
        account: accountField.optional().describe(
          "Optional/backward compatibility only. Public Apify search does not use your Threads account token."
        ),
        query: z.string().min(1).describe("Keyword, phrase, or hashtag to search on public Threads"),
        search_type: z
          .enum(["TOP", "RECENT"])
          .default("RECENT")
          .describe("TOP = relevance/popularity, RECENT = prioritize newer posts"),
        search_mode: z
          .enum(["KEYWORD", "TAG"])
          .default("KEYWORD")
          .describe("KEYWORD = normal search, TAG = hashtag/topic-tag surface"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("How many final posts to return (1-50). The Actor may fetch more internally for ranking."),
        sort_by: z
          .enum(["BALANCED", "RECENT", "ENGAGEMENT"])
          .default("BALANCED")
          .describe("BALANCED mixes freshness and engagement; RECENT newest first; ENGAGEMENT busiest first"),
        include_replies: z
          .boolean()
          .default(false)
          .describe("Include replies that match the search. false = prefer standalone posts."),
        min_likes: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Optional minimum likes filter for the primary Actor"),
        since: z
          .string()
          .optional()
          .describe("Optional start date/time, e.g. 2026-09-01. Useful for recent monitoring."),
        until: z
          .string()
          .optional()
          .describe("Optional end date/time, e.g. 2026-09-18"),
        fallback_on_low_results: z
          .boolean()
          .default(true)
          .describe("Automatically try the backup Actor when the cheap Actor fails or returns fewer results than requested"),
      },
    },
    async ({
      query,
      search_type,
      search_mode,
      limit,
      sort_by,
      include_replies,
      min_likes,
      since,
      until,
      fallback_on_low_results,
    }) => {
      if (!APIFY_TOKEN) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "APIFY_TOKEN belum ada di environment Render. Tambahkan APIFY_TOKEN lalu redeploy.",
            },
          ],
        };
      }

      const attempts = [];
      let combined = [];
      let primaryFailed = false;

      try {
        const primary = await searchWithPrimary({
          query: query.trim(),
          limit,
          searchType: search_type,
          searchMode: search_mode,
          includeReplies: include_replies,
          minLikes: min_likes,
          since,
        });
        attempts.push({ actor: APIFY_PRIMARY_ACTOR, status: "ok", results: primary.length });
        combined.push(...primary);
      } catch (err) {
        primaryFailed = true;
        attempts.push({
          actor: APIFY_PRIMARY_ACTOR,
          status: "error",
          error: err?.message || String(err),
        });
      }

      const primaryCount = dedupePosts(combined).length;
      const shouldFallback =
        fallback_on_low_results && (primaryFailed || primaryCount < Math.min(limit, 10));

      if (shouldFallback) {
        try {
          const fallback = await searchWithFallback({
            query: query.trim(),
            limit,
            searchType: search_type,
            searchMode: search_mode,
            includeReplies: include_replies,
            since,
            until,
          });
          attempts.push({ actor: APIFY_FALLBACK_ACTOR, status: "ok", results: fallback.length });
          combined.push(...fallback);
        } catch (err) {
          attempts.push({
            actor: APIFY_FALLBACK_ACTOR,
            status: "error",
            error: err?.message || String(err),
          });
        }
      }

      // Apply exact date bounds locally as a second safety layer because Actor
      // search surfaces can contain mixed-age results.
      const sinceMs = since ? new Date(since).getTime() : null;
      const untilMs = until ? new Date(until).getTime() : null;
      let posts = dedupePosts(combined).filter((p) => {
        if (!p.timestamp) return !since && !until;
        const t = new Date(p.timestamp).getTime();
        if (!Number.isFinite(t)) return !since && !until;
        if (Number.isFinite(sinceMs) && t < sinceMs) return false;
        if (Number.isFinite(untilMs) && t > untilMs) return false;
        return true;
      });

      posts = sortPosts(posts, sort_by).slice(0, limit);

      if (posts.length === 0 && attempts.every((a) => a.status === "error")) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  query,
                  error: "Kedua Apify Actor gagal.",
                  attempts,
                  hint: "Cek APIFY_TOKEN, kredit Apify, atau status Actor di Apify Console.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                query,
                provider: "Apify public Threads search",
                search_type,
                search_mode,
                sort_by,
                returned: posts.length,
                attempts,
                note:
                  "Hasil berasal dari halaman publik Threads yang dibaca oleh Actor Apify, bukan endpoint keyword_search resmi Meta. Search publik dapat tidak lengkap karena Threads membatasi hasil yang terlihat untuk pengunjung logged-out.",
                results: posts,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "diagnose_apify_search",
    {
      title: "Diagnose Apify Threads search",
      description:
        "Test whether APIFY_TOKEN works and whether the primary/fallback Threads search Actors can currently return public results.",
      inputSchema: {
        query: z.string().min(1).default("threads").describe("Small test query"),
      },
    },
    async ({ query }) => {
      const report = {
        token_configured: Boolean(APIFY_TOKEN),
        primary_actor: APIFY_PRIMARY_ACTOR,
        fallback_actor: APIFY_FALLBACK_ACTOR,
        tests: [],
      };
      if (!APIFY_TOKEN) {
        report.tests.push({ status: "error", error: "APIFY_TOKEN missing" });
        return { isError: true, content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
      }

      try {
        const rows = await searchWithPrimary({
          query,
          limit: 3,
          searchType: "TOP",
          searchMode: "KEYWORD",
          includeReplies: false,
          minLikes: 0,
        });
        report.tests.push({ actor: APIFY_PRIMARY_ACTOR, status: "ok", results: rows.length });
      } catch (err) {
        report.tests.push({ actor: APIFY_PRIMARY_ACTOR, status: "error", error: err?.message || String(err) });
      }

      if (report.tests[0]?.status !== "ok") {
        try {
          const rows = await searchWithFallback({
            query,
            limit: 3,
            searchType: "TOP",
            searchMode: "KEYWORD",
            includeReplies: false,
          });
          report.tests.push({ actor: APIFY_FALLBACK_ACTOR, status: "ok", results: rows.length });
        } catch (err) {
          report.tests.push({ actor: APIFY_FALLBACK_ACTOR, status: "error", error: err?.message || String(err) });
        }
      }

      const ok = report.tests.some((t) => t.status === "ok");
      return {
        ...(ok ? {} : { isError: true }),
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
      };
    }
  );

  server.registerTool(
    "diagnose_threads_search",
    {
      title: "Diagnose Threads keyword-search access",
      description:
        "Check whether the selected Threads token itself works and whether Meta currently allows /keyword_search. Use this before repeatedly retrying a failing search.",
      inputSchema: {
        account: accountField,
      },
    },
    async ({ account }) => {
      const { accessToken, label } = getAccount(account);
      const report = { account, label, basic_api: null, keyword_search: null };

      try {
        const me = await threadsFetch(accessToken, "/me", {
          params: { fields: "id,username" },
        });
        report.basic_api = { ok: true, id: me.id, username: me.username };
      } catch (err) {
        report.basic_api = { ok: false, error: explainThreadsError(err) };
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
        };
      }

      try {
        const probe = await threadsFetch(accessToken, "/keyword_search", {
          params: {
            q: "threads",
            search_type: "RECENT",
            search_mode: "KEYWORD",
            limit: 1,
            fields: "id,text,permalink,timestamp,username",
          },
        });
        report.keyword_search = {
          ok: true,
          returned: Array.isArray(probe.data) ? probe.data.length : 0,
          note:
            "Endpoint berhasil. Jika hasil publik tetap tidak muncul, periksa apakah app sudah mendapat akses Meta yang diperlukan untuk public keyword search.",
        };
      } catch (err) {
        report.keyword_search = { ok: false, error: explainThreadsError(err) };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
      };
    }
  );

  server.registerTool(
    "list_accounts",
    {
      title: "List configured Threads accounts",
      description:
        "Show which Threads accounts are configured on this server (their label and username), so you know what to pass as 'account' to other tools.",
      inputSchema: {},
    },
    async () => {
      const results = [];
      for (const [key, acc] of Object.entries(ACCOUNTS)) {
        if (!acc.accessToken || !acc.userId) {
          results.push({ key, label: acc.label, status: "not configured" });
          continue;
        }
        try {
          const me = await threadsFetch(acc.accessToken, "/me", {
            params: { fields: "id,username" },
          });
          results.push({ key, label: acc.label, username: me.username, id: me.id, status: "ok" });
        } catch (err) {
          results.push({ key, label: acc.label, status: "error", error: String(err.message || err) });
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.registerTool(
    "get_profile_info",
    {
      title: "Get Threads profile info",
      description: "Fetch profile info (username, bio, follower count, profile picture) for a configured account.",
      inputSchema: {
        account: accountField,
      },
    },
    async ({ account }) => {
      const { accessToken } = getAccount(account);
      const data = await threadsFetch(accessToken, "/me", {
        params: {
          fields: "id,username,name,threads_biography,threads_profile_picture_url",
        },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "post_thread",
    {
      title: "Post to Threads",
      description:
        "Create and publish a new post on Threads. Supports plain text, text with a single image URL, or text with a single video URL. Image/video must be a public, direct URL (e.g. from Imgur) — not a preview/share link.",
      inputSchema: {
        account: accountField,
        text: z.string().min(1).describe("The text content of the post"),
        image_url: z
          .string()
          .url()
          .optional()
          .describe("Optional public direct URL of an image to attach to the post"),
        video_url: z
          .string()
          .url()
          .optional()
          .describe(
            "Optional public direct URL of a video to attach to the post (mutually exclusive with image_url). Videos take longer to process."
          ),
      },
    },
    async ({ account, text, image_url, video_url }) => {
      const { accessToken, userId, label } = getAccount(account);
      const mediaType = video_url ? "VIDEO" : image_url ? "IMAGE" : "TEXT";
      const container = await threadsFetch(accessToken, `/${userId}/threads`, {
        method: "POST",
        body: {
          media_type: mediaType,
          text,
          ...(video_url ? { video_url } : {}),
          ...(image_url ? { image_url } : {}),
        },
      });

      // Poll the container status until it's FINISHED instead of a fixed short
      // delay — videos in particular can take a while to process on Meta's side.
      const maxAttempts = mediaType === "VIDEO" ? 40 : 10; // ~2min for video, ~30s for image/text
      let status = "IN_PROGRESS";
      for (let i = 0; i < maxAttempts; i++) {
        await sleep(3000);
        const statusCheck = await threadsFetch(accessToken, `/${container.id}`, {
          params: { fields: "status,error_message" },
        });
        status = statusCheck.status;
        if (status === "FINISHED") break;
        if (status === "ERROR") {
          throw new Error(`Media processing failed: ${statusCheck.error_message || "unknown error"}`);
        }
      }
      if (status !== "FINISHED") {
        throw new Error(
          `Media masih diproses setelah menunggu (status: ${status}). Coba cek lagi nanti pakai creation_id: ${container.id}`
        );
      }

      const published = await threadsFetch(accessToken, `/${userId}/threads_publish`, {
        method: "POST",
        body: { creation_id: container.id },
      });

      return {
        content: [
          { type: "text", text: `[${label}] Post published successfully. Post ID: ${published.id}` },
        ],
      };
    }
  );

  server.registerTool(
    "get_my_posts",
    {
      title: "Get my Threads posts",
      description:
        "Fetch recent posts from the connected Threads account. Supports pagination — if there are more posts beyond the limit, the response includes a 'next_cursor' you can pass back in as 'after' to get the next page. Call this repeatedly with the returned cursor to walk through ALL posts.",
      inputSchema: {
        account: accountField,
        limit: z.number().int().min(1).max(50).default(25).describe("Number of posts to fetch per page (max 50)"),
        after: z
          .string()
          .optional()
          .describe("Pagination cursor from a previous call's next_cursor, to fetch the next page"),
      },
    },
    async ({ account, limit, after }) => {
      const { accessToken, userId } = getAccount(account);
      const data = await threadsFetch(accessToken, `/${userId}/threads`, {
        params: {
          fields: "id,text,timestamp,permalink,media_type",
          limit,
          ...(after ? { after } : {}),
        },
      });

      const nextCursor = data.paging?.cursors?.after || null;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                posts: data.data || [],
                next_cursor: nextCursor,
                has_more: Boolean(nextCursor),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_full_thread",
    {
      title: "Get a full self-reply thread chain",
      description:
        "Walk a chain of self-replies (a thread where the author keeps replying to their own previous post, e.g. '1/20', '2/20', ...) starting from the first post, and return all parts concatenated in order. Use this for long storytelling threads split into numbered parts.",
      inputSchema: {
        account: accountField,
        post_id: z.string().min(1).describe("The ID of the FIRST post in the thread"),
        max_parts: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(30)
          .describe("Safety limit on how many parts to follow"),
      },
    },
    async ({ account, post_id, max_parts }) => {
      const { accessToken } = getAccount(account);

      const parts = [];
      let currentId = post_id;
      let authorUsername = null;

      for (let i = 0; i < max_parts; i++) {
        const detail = await threadsFetch(accessToken, `/${currentId}`, {
          params: { fields: "id,text,timestamp,username" },
        });
        parts.push({ id: detail.id, username: detail.username, text: detail.text });
        if (!authorUsername) authorUsername = detail.username;

        const repliesData = await threadsFetch(accessToken, `/${currentId}/replies`, {
          params: { fields: "id,text,timestamp,username" },
        });
        const replies = (repliesData.data || [])
          .filter((r) => r.username === authorUsername)
          .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        if (replies.length === 0) break;
        currentId = replies[0].id;
      }

      const combined = parts
        .map((p, idx) => `--- Bagian ${idx + 1}/${parts.length} (ID: ${p.id}) ---\n${p.text}`)
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: `Total ${parts.length} bagian ditemukan.\n\n${combined}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_post_detail",
    {
      title: "Get full detail of a single post",
      description:
        "Fetch the FULL, untruncated text and details of a single Threads post by its ID. Use this when get_my_posts returns truncated text.",
      inputSchema: {
        account: accountField,
        post_id: z.string().min(1).describe("The Threads post/media ID"),
      },
    },
    async ({ account, post_id }) => {
      const { accessToken } = getAccount(account);
      const data = await threadsFetch(accessToken, `/${post_id}`, {
        params: { fields: "id,text,timestamp,permalink,media_type,username" },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "get_post_insights",
    {
      title: "Get post insights",
      description:
        "Fetch performance metrics (views, likes, replies, reposts, quotes) for a specific post.",
      inputSchema: {
        account: accountField,
        post_id: z.string().min(1).describe("The Threads post/media ID"),
      },
    },
    async ({ account, post_id }) => {
      const { accessToken } = getAccount(account);
      const data = await threadsFetch(accessToken, `/${post_id}/insights`, {
        params: { metric: "views,likes,replies,reposts,quotes" },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "get_replies",
    {
      title: "Get replies to a post",
      description:
        "Fetch replies/comments on a specific Threads post. Supports pagination — if there are more replies, the response includes a 'next_cursor' you can pass back in to get the next page.",
      inputSchema: {
        account: accountField,
        post_id: z.string().min(1).describe("The Threads post/media ID"),
        after: z
          .string()
          .optional()
          .describe("Pagination cursor from a previous call's next_cursor, to fetch the next page"),
      },
    },
    async ({ account, post_id, after }) => {
      const { accessToken } = getAccount(account);
      const data = await threadsFetch(accessToken, `/${post_id}/replies`, {
        params: {
          fields: "id,text,username,timestamp",
          ...(after ? { after } : {}),
        },
      });

      const nextCursor = data.paging?.cursors?.after || null;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                replies: data.data || [],
                next_cursor: nextCursor,
                has_more: Boolean(nextCursor),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "hide_reply",
    {
      title: "Hide or unhide a reply",
      description:
        "Hide (or unhide) a top-level reply on your Threads post. Hidden replies are only visible to you and the person who wrote them — everyone else won't see it. This automatically hides all nested replies under it too. Use this as an alternative to blocking a specific commenter, since Threads API doesn't support blocking users directly.",
      inputSchema: {
        account: accountField,
        reply_id: z.string().min(1).describe("The ID of the reply to hide/unhide"),
        hide: z.boolean().default(true).describe("true to hide, false to unhide"),
      },
    },
    async ({ account, reply_id, hide }) => {
      const { accessToken } = getAccount(account);
      const data = await threadsFetch(accessToken, `/${reply_id}/manage_reply`, {
        method: "POST",
        params: { hide },
      });
      return {
        content: [
          {
            type: "text",
            text: `Reply ${reply_id} ${hide ? "disembunyikan" : "ditampilkan lagi"}. Response: ${JSON.stringify(data)}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "delete_post",
    {
      title: "Delete a Threads post or reply",
      description:
        "Permanently delete a post or reply on Threads by its ID. Requires the threads_delete permission to be enabled on the Meta App — if this fails with a permission error, that permission needs to be added in the Meta App dashboard first.",
      inputSchema: {
        account: accountField,
        post_id: z.string().min(1).describe("The ID of the post/reply to delete"),
      },
    },
    async ({ account, post_id }) => {
      const { accessToken } = getAccount(account);
      const data = await threadsFetch(accessToken, `/${post_id}`, {
        method: "DELETE",
      });
      return {
        content: [
          {
            type: "text",
            text: `Post ${post_id} deleted. Response: ${JSON.stringify(data)}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "reply_to_post",
    {
      title: "Reply to a Threads post",
      description: "Post a reply to an existing Threads post or comment.",
      inputSchema: {
        account: accountField,
        reply_to_id: z.string().min(1).describe("The ID of the post/comment to reply to"),
        text: z.string().min(1).describe("The reply text"),
      },
    },
    async ({ account, reply_to_id, text }) => {
      const { accessToken, userId, label } = getAccount(account);
      const container = await threadsFetch(accessToken, `/${userId}/threads`, {
        method: "POST",
        body: { media_type: "TEXT", text, reply_to_id },
      });

      await sleep(2000);

      const published = await threadsFetch(accessToken, `/${userId}/threads_publish`, {
        method: "POST",
        body: { creation_id: container.id },
      });

      return {
        content: [{ type: "text", text: `[${label}] Reply published successfully. Reply ID: ${published.id}` }],
      };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP server (stateless — one MCP server instance per request)
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

app.get("/", (_req, res) => {
  res.send(`Threads MCP server is running. Public search: ${APIFY_TOKEN ? "Apify configured" : "APIFY_TOKEN missing"}.`);
});

// OAuth redirect target — just displays the code so it's easy to copy.
app.get("/callback", (req, res) => {
  const { code, error, error_description } = req.query;
  if (error) {
    res.send(`<html><body style="font-family:sans-serif;padding:2rem">
      <h2>OAuth error</h2>
      <p><b>${error}</b></p>
      <p>${error_description || ""}</p>
    </body></html>`);
    return;
  }
  res.send(`<html><body style="font-family:sans-serif;padding:2rem">
    <h2>Authorization code:</h2>
    <pre style="background:#eee;padding:1rem;word-break:break-all">${code || "(tidak ada code di URL)"}</pre>
    <p>Copy kode di atas, lalu pakai untuk tukar ke access token.</p>
  </body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Threads MCP server listening on port ${PORT}`);
});
