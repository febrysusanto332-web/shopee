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

// Reserve search provider. It is only used automatically when Apify reports
// HTTP 402 / exhausted usage. The user-facing response deliberately labels
// this source only as "Limited Token Creator".
const LIMITED_TOKEN_API_BASE = "https://api.scrapecreators.com/v1";
const LIMITED_TOKEN_API_KEY = process.env.SCRAPECREATORS_API_KEY || "";
const LIMITED_TOKEN_NOTICE = "⚠️ Limited Token Creator sedang digunakan.";

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

class LimitedTokenError extends Error {
  constructor(message, { status, data } = {}) {
    super(message);
    this.name = "LimitedTokenError";
    this.status = status;
    this.data = data;
  }
}

function isApifyBudgetExhausted(err) {
  if (!(err instanceof ApifyError)) return false;
  const type = String(err?.data?.error?.type || err?.data?.type || "").toLowerCase();
  const message = String(
    err?.data?.error?.message || err?.data?.message || err?.message || ""
  ).toLowerCase();

  if (Number(err.status) === 402) return true;
  const budgetTypes = new Set([
    "monthly-usage-limit-too-low",
    "not-enough-usage-to-run-paid-actor",
    "limit-reached",
    "x402-payment-required",
  ]);
  if (budgetTypes.has(type)) return true;
  return [
    "usage limit",
    "not enough credits",
    "insufficient credits",
    "payment required",
    "monthly usage",
    "not enough usage",
  ].some((needle) => message.includes(needle));
}

async function limitedTokenThreadsSearch({ query, since, until }) {
  if (!LIMITED_TOKEN_API_KEY) {
    throw new LimitedTokenError(
      "SCRAPECREATORS_API_KEY belum dikonfigurasi di Render. Tambahkan key tersebut agar Limited Token Creator dapat dipakai saat Apify habis."
    );
  }

  const url = new URL(`${LIMITED_TOKEN_API_BASE}/threads/search`);
  url.searchParams.set("query", String(query || "").trim());
  if (since) url.searchParams.set("start_date", dateOnly(since));
  if (until) url.searchParams.set("end_date", dateOnly(until));
  url.searchParams.set("trim", "false");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  let res;
  try {
    res = await fetch(url.toString(), {
      method: "GET",
      headers: { "x-api-key": LIMITED_TOKEN_API_KEY },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err?.name === "AbortError") {
      throw new LimitedTokenError("Limited Token Creator timeout setelah 60 detik.");
    }
    throw new LimitedTokenError(`Limited Token Creator tidak dapat dihubungi: ${err?.message || err}`);
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
    let msg = data?.error?.message || data?.message || data?.error || data?.raw || res.statusText || "Unknown error";
    if (res.status === 402) msg = "Limited Token Creator kehabisan kredit.";
    throw new LimitedTokenError(`Limited Token Creator ${res.status}: ${msg}`, {
      status: res.status,
      data,
    });
  }

  const rows = Array.isArray(data?.posts) ? data.posts : [];
  return {
    rows,
    creditsRemaining: Number.isFinite(Number(data?.credits_remaining))
      ? Number(data.credits_remaining)
      : null,
    creditsCharged: Number.isFinite(Number(data?.credits_charged))
      ? Number(data.credits_charged)
      : null,
  };
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

function epochToIso(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n > 10_000_000_000 ? n : n * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function fragmentsToText(item) {
  const fragments = item?.text_post_app_info?.text_fragments?.fragments;
  if (!Array.isArray(fragments)) return "";
  return fragments
    .map((f) => f?.plaintext || f?.mention_fragment?.username || f?.link_fragment?.url || "")
    .filter(Boolean)
    .join("");
}

function normalizeLimitedTokenPost(item) {
  const username = item?.user?.username ?? item?.username ?? null;
  const code = item?.code ?? item?.shortcode ?? null;
  const text = item?.caption?.text ?? item?.text ?? fragmentsToText(item);
  const likeCount = asNumber(item?.like_count, item?.likeCount);
  const replyCount = asNumber(
    item?.text_post_app_info?.direct_reply_count,
    item?.reply_count,
    item?.replyCount
  );
  const repostCount = asNumber(
    item?.text_post_app_info?.repost_count,
    item?.repost_count,
    item?.repostCount
  );
  const quoteCount = asNumber(
    item?.text_post_app_info?.quote_count,
    item?.quote_count,
    item?.quoteCount
  );
  const reshareCount = asNumber(
    item?.text_post_app_info?.reshare_count,
    item?.reshare_count,
    item?.reshareCount
  );
  const timestamp =
    item?.timestamp ?? item?.created_at ?? epochToIso(item?.taken_at ?? item?.takenAt);
  const url =
    item?.url ??
    item?.permalink ??
    (username && code ? `https://www.threads.com/@${username}/post/${code}` : null);

  return {
    id: String(item?.id ?? item?.pk ?? code ?? ""),
    url,
    text: text || "",
    timestamp,
    username,
    full_name: item?.user?.full_name ?? item?.full_name ?? null,
    like_count: likeCount,
    reply_count: replyCount,
    repost_count: repostCount,
    quote_count: quoteCount,
    reshare_count: reshareCount,
    engagement_total: likeCount + replyCount + repostCount + quoteCount,
    is_reply: Boolean(item?.text_post_app_info?.is_reply ?? item?.is_reply),
    is_quote_post: Boolean(
      item?.text_post_app_info?.share_info?.quoted_post ||
        item?.text_post_app_info?.share_info?.quoted_attachment_post
    ),
    media_type: item?.media_type ?? null,
    image_url: item?.image_versions2?.candidates?.[0]?.url ?? null,
    video_url: item?.video_versions?.[0]?.url ?? null,
    author_profile_url: username ? `https://www.threads.com/@${username}` : null,
    author_verified: Boolean(item?.user?.is_verified),
    search_surface: "keyword",
    source: "limited_token_creator",
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

// Threads' logged-out search is intentionally shallow and can miss niche/low-engagement
// posts that are visible to a signed-in user. When an exact phrase returns nothing,
// generate a few conservative variants and let the second Actor search ALL surfaces.
const QUERY_STOPWORDS = new Set([
  "yang", "dan", "atau", "di", "ke", "dari", "untuk", "dengan", "pada", "ini", "itu",
  "coba", "cari", "carikan", "keyword", "posting", "postingan", "threads", "thread"
]);

function searchTokens(query) {
  return String(query || "")
    .toLowerCase()
    .replace(/[#@]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !QUERY_STOPWORDS.has(t));
}

function buildRescueQueries(query) {
  const base = String(query || "").trim();
  const tokens = [...new Set(searchTokens(base))];
  const out = [];
  const add = (q) => {
    q = String(q || "").trim();
    if (!q || q.toLowerCase() === base.toLowerCase()) return;
    if (!out.some((x) => x.toLowerCase() === q.toLowerCase())) out.push(q);
  };

  // Reverse a two-word phrase because Threads sometimes ranks a different token order.
  if (tokens.length === 2) add(`${tokens[1]} ${tokens[0]}`);

  // Two-token combinations preserve intent while being less strict than the full phrase.
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      add(`${tokens[i]} ${tokens[j]}`);
      if (out.length >= 4) return out;
    }
  }

  // Last-resort single-token probes for a two-word niche query. Results are filtered
  // locally so broad matches are not returned unless the original words are present.
  if (tokens.length === 2) {
    add(tokens[0]);
    add(tokens[1]);
  }
  return out.slice(0, 4);
}

function queryMatchInfo(post, originalQuery) {
  const tokens = [...new Set(searchTokens(originalQuery))];
  if (!tokens.length) return { matched: 0, total: 0, ratio: 1 };
  const hay = String(`${post?.text || ""} ${post?.username || ""}`).toLowerCase();
  const matched = tokens.filter((t) => hay.includes(t)).length;
  return { matched, total: tokens.length, ratio: matched / tokens.length };
}

function keepRescueRelevant(posts, originalQuery) {
  const tokens = [...new Set(searchTokens(originalQuery))];
  if (tokens.length <= 1) return posts;
  const minMatched = Math.min(2, tokens.length);
  return posts
    .map((p) => {
      const m = queryMatchInfo(p, originalQuery);
      return { ...p, query_match_tokens: m.matched, query_match_ratio: Number(m.ratio.toFixed(3)) };
    })
    .filter((p) => p.query_match_tokens >= minMatched);
}

const QUALITY_RANK = { ECONOMY: 1, BALANCED: 2, DEEP: 3 };
const SEARCH_CACHE = new Map();

function resolveQualityMode(requestedMode, requestContext, query) {
  if (requestedMode && requestedMode !== "AUTO") return requestedMode;

  const text = `${requestContext || ""} ${query || ""}`.toLowerCase();
  const economySignals = [
    "mode economy",
    "economy mode",
    "hemat biaya",
    "paling hemat",
    "sehemat mungkin",
    "minimum biaya",
    "murah saja",
  ];
  if (economySignals.some((x) => text.includes(x))) return "ECONOMY";

  const deepSignals = [
    "mode deep",
    "deep search",
    "secara mendalam",
    "cari mendalam",
    "benar-benar paling",
    "benar benar paling",
    "paling ramai dan relevan",
    "paling relevan dan ramai",
    "sebanyak mungkin",
    "cari lebih luas",
    "riset mendalam",
    "cross-check",
    "cross check",
    "pilih yang terbaik dari banyak kandidat",
    "prospek terbaik",
    "paling bagus untuk prospek",
  ];
  if (deepSignals.some((x) => text.includes(x))) return "DEEP";

  return "BALANCED";
}

function qualityPlan(mode, limit) {
  if (mode === "ECONOMY") {
    return {
      primaryFetch: Math.min(100, Math.max(limit + 3, Math.ceil(limit * 1.25))),
      fallbackFetch: Math.min(100, Math.max(limit, Math.ceil(limit * 1.25))),
      fallbackThreshold: 0, // only fall back on an actual primary failure
    };
  }
  if (mode === "DEEP") {
    return {
      primaryFetch: Math.min(100, Math.max(35, Math.ceil(limit * 4))),
      fallbackFetch: Math.min(100, Math.max(20, Math.ceil(limit * 2))),
      fallbackThreshold: limit, // deep aims to fill the requested count before ranking
    };
  }
  return {
    primaryFetch: Math.min(100, Math.max(limit + 5, Math.ceil(limit * 1.6))),
    fallbackFetch: Math.min(100, Math.max(limit, Math.ceil(limit * 1.25))),
    fallbackThreshold: Math.max(3, Math.ceil(limit * 0.5)),
  };
}

function cacheTtlMs(searchType, sortBy) {
  if (searchType === "RECENT" || sortBy === "RECENT") return 5 * 60 * 1000;
  if (sortBy === "ENGAGEMENT") return 15 * 60 * 1000;
  return 30 * 60 * 1000;
}

function cacheKey({ query, searchType, searchMode, includeReplies, minLikes, since, until }) {
  return JSON.stringify({
    q: String(query || "").trim().toLowerCase(),
    searchType,
    searchMode,
    includeReplies: Boolean(includeReplies),
    minLikes: Number(minLikes || 0),
    since: since || null,
    until: until || null,
  });
}

function getCachedSearch(key, requestedMode, limit, ttlMs) {
  const cached = SEARCH_CACHE.get(key);
  if (!cached) return null;
  if (Date.now() - cached.createdAt > ttlMs) {
    SEARCH_CACHE.delete(key);
    return null;
  }
  if ((QUALITY_RANK[cached.qualityMode] || 0) < (QUALITY_RANK[requestedMode] || 0)) return null;
  if (!Array.isArray(cached.posts) || cached.posts.length < limit) return null;
  return cached;
}

function setCachedSearch(key, qualityMode, posts, metadata = {}) {
  if (!Array.isArray(posts) || posts.length === 0) return;
  const old = SEARCH_CACHE.get(key);
  if (old && (QUALITY_RANK[old.qualityMode] || 0) > (QUALITY_RANK[qualityMode] || 0)) return;
  SEARCH_CACHE.set(key, {
    createdAt: Date.now(),
    qualityMode,
    posts: dedupePosts(posts).slice(0, 200),
    usedLimitedToken: Boolean(metadata.usedLimitedToken),
    limitedCreditsRemaining:
      Number.isFinite(Number(metadata.limitedCreditsRemaining))
        ? Number(metadata.limitedCreditsRemaining)
        : null,
  });

  // Keep memory bounded on long-running Render instances.
  if (SEARCH_CACHE.size > 150) {
    const oldest = [...SEARCH_CACHE.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (oldest) SEARCH_CACHE.delete(oldest[0]);
  }
}

async function searchWithPrimary({ query, fetchLimit, searchType, searchMode, includeReplies, minLikes, since }) {
  const safeLimit = Math.max(1, Math.min(100, fetchLimit));
  const input = {
    keywords: [query],
    searchType: searchMode === "TAG" ? "tags" : searchType === "TOP" ? "top" : "both",
    passesPerSurface: searchType === "RECENT" ? 2 : 1,
    maxPostsPerKeyword: safeLimit,
    maxItems: safeLimit,
    minLikes,
    postedWithinDays: daysFromSince(since, searchType === "RECENT" ? 30 : 0),
    excludeReplies: !includeReplies,
    onlyWithLinks: false,
    requestConcurrency: 1,
    proxyConfiguration: { useApifyProxy: true },
  };
  const rows = await apifyRunActor(APIFY_PRIMARY_ACTOR, input, { billingLimit: safeLimit });
  return rows.map((x) => normalizeApifyPost(x, "apify_primary"));
}

async function searchWithFallback({ query, queries, fetchLimit, searchType, searchMode, includeReplies, since, until }) {
  const safeLimit = Math.max(1, Math.min(100, fetchLimit));
  const searchQueries = Array.isArray(queries) && queries.length
    ? [...new Set(queries.map((q) => String(q || "").trim()).filter(Boolean))]
    : [query];
  const input = {
    searchQueries,
    // For recall, KEYWORD fallback reads Top + Recent + Tags. Final RECENT/TOP
    // ordering is done locally after de-duplication. This avoids false zeroes on
    // niche terms that exist only on one Threads search surface.
    searchType: searchMode === "TAG" ? "tags" : "all",
    maxItems: safeLimit,
    includeReplies,
    ...(since ? { postedAfter: dateOnly(since) } : {}),
    ...(until ? { postedBefore: dateOnly(until) } : {}),
    proxyConfiguration: { useApifyProxy: true },
  };
  const rows = await apifyRunActor(APIFY_FALLBACK_ACTOR, input, { billingLimit: safeLimit });
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
  const server = new McpServer({ name: "threads-mcp", version: "1.3.0" });

  server.registerTool(
    "search_threads",
    {
      title: "Search public Threads posts",
      description:
        "Search PUBLIC Threads posts. Default quality_mode=AUTO. IMPORTANT: public/logged-out search is not exhaustive; returned=0 MUST NOT be interpreted as proof that no matching Threads posts exist. The server automatically tries multiple public search surfaces and conservative query variants when an exact niche phrase returns zero. Apify is used first; if Apify reports that its monthly usage/credits are exhausted, the server switches to a reserve source and returns the notice 'Limited Token Creator sedang digunakan.' Use RECENT for newest, TOP for popular/relevant, and BALANCED sorting for freshness + engagement.",
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
        quality_mode: z
          .enum(["AUTO", "ECONOMY", "BALANCED", "DEEP"])
          .default("AUTO")
          .describe(
            "AUTO is recommended: use ECONOMY only when the user explicitly asks to minimize cost; use DEEP when the user asks for a deep/wide search, the truly most relevant/busiest posts, as many candidates as possible, cross-checking, or the best prospects; otherwise AUTO resolves to BALANCED."
          ),
        request_context: z
          .string()
          .optional()
          .describe(
            "Optional short copy of the user's original search request. In AUTO mode, pass the user's wording here so the server can detect intents like 'benar-benar paling ramai dan relevan' -> DEEP or 'mode economy' -> ECONOMY."
          ),
        fallback_on_low_results: z
          .boolean()
          .default(true)
          .describe(
            "Allow the backup Actor under the selected quality policy. ECONOMY uses it only if the primary Actor fails; BALANCED only if results are very sparse; DEEP may use it whenever needed to fill the requested count."
          ),
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
      quality_mode,
      request_context,
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

      const resolvedQualityMode = resolveQualityMode(quality_mode, request_context, query);
      const plan = qualityPlan(resolvedQualityMode, limit);
      const ttlMs = cacheTtlMs(search_type, sort_by);
      const key = cacheKey({
        query,
        searchType: search_type,
        searchMode: search_mode,
        includeReplies: include_replies,
        minLikes: min_likes,
        since,
        until,
      });

      const cached = getCachedSearch(key, resolvedQualityMode, limit, ttlMs);
      if (cached) {
        const cachedPosts = sortPosts(cached.posts, sort_by).slice(0, limit);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  query,
                  provider: cached.usedLimitedToken ? "Limited Token Creator" : "Primary public Threads search",
                  ...(cached.usedLimitedToken ? { notice: LIMITED_TOKEN_NOTICE } : {}),
                  quality_mode_requested: quality_mode,
                  quality_mode_resolved: resolvedQualityMode,
                  cache_hit: true,
                  cache_age_seconds: Math.round((Date.now() - cached.createdAt) / 1000),
                  cache_ttl_seconds: Math.round(ttlMs / 1000),
                  search_type,
                  search_mode,
                  sort_by,
                  returned: cachedPosts.length,
                  attempts: [],
                  note: cached.usedLimitedToken
                    ? "Hasil diambil dari cache in-memory MCP. Sumber cadangan ber-token terbatas sedang digunakan."
                    : "Hasil diambil dari cache in-memory MCP untuk menghemat kredit. Cache RECENT sekitar 5 menit; engagement sekitar 15 menit; TOP/BALANCED sekitar 30 menit.",
                  ...(cached.usedLimitedToken && cached.limitedCreditsRemaining !== null
                    ? { limited_token_credits_remaining: cached.limitedCreditsRemaining }
                    : {}),
                  results: cachedPosts,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const attempts = [];
      let combined = [];
      let primaryFailed = false;
      let apifyBudgetExhausted = false;
      let usedLimitedToken = false;
      let limitedCreditsRemaining = null;

      try {
        const primary = await searchWithPrimary({
          query: query.trim(),
          fetchLimit: plan.primaryFetch,
          searchType: search_type,
          searchMode: search_mode,
          includeReplies: include_replies,
          minLikes: min_likes,
          since,
        });
        attempts.push({
          actor: APIFY_PRIMARY_ACTOR,
          status: "ok",
          requested_candidates: plan.primaryFetch,
          results: primary.length,
        });
        combined.push(...primary);
      } catch (err) {
        primaryFailed = true;
        apifyBudgetExhausted = isApifyBudgetExhausted(err);
        attempts.push({
          actor: APIFY_PRIMARY_ACTOR,
          status: "error",
          requested_candidates: plan.primaryFetch,
          error: err?.message || String(err),
          ...(apifyBudgetExhausted ? { budget_exhausted: true } : {}),
        });
      }

      const primaryCount = dedupePosts(combined).length;
      let shouldFallback = false;
      if (fallback_on_low_results) {
        if (primaryFailed) {
          shouldFallback = true;
        } else if (resolvedQualityMode === "DEEP") {
          shouldFallback = primaryCount < plan.fallbackThreshold;
        } else if (resolvedQualityMode === "BALANCED") {
          shouldFallback = primaryCount < plan.fallbackThreshold;
        } else {
          shouldFallback = false;
        }
      }

      if (shouldFallback && !apifyBudgetExhausted) {
        try {
          const fallback = await searchWithFallback({
            query: query.trim(),
            fetchLimit: plan.fallbackFetch,
            searchType: search_type,
            searchMode: search_mode,
            includeReplies: include_replies,
            since,
            until,
          });
          attempts.push({
            actor: APIFY_FALLBACK_ACTOR,
            status: "ok",
            requested_candidates: plan.fallbackFetch,
            results: fallback.length,
          });
          combined.push(...fallback);
        } catch (err) {
          const exhausted = isApifyBudgetExhausted(err);
          if (exhausted) apifyBudgetExhausted = true;
          attempts.push({
            actor: APIFY_FALLBACK_ACTOR,
            status: "error",
            requested_candidates: plan.fallbackFetch,
            error: err?.message || String(err),
            ...(exhausted ? { budget_exhausted: true } : {}),
          });
        }
      }

      // ZERO-RESULT RESCUE: a signed-out Threads search can return 0 even when
      // the signed-in Threads app shows matching low-engagement posts. If both
      // normal Apify passes produced nothing, try a few conservative variants
      // across ALL public search surfaces, then locally require the original
      // query tokens so broad probes do not pollute the answer. This still uses
      // Apify; Limited Token Creator remains reserved for actual Apify budget exhaustion.
      if (!apifyBudgetExhausted && dedupePosts(combined).length === 0) {
        const rescueQueries = buildRescueQueries(query);
        if (rescueQueries.length > 0) {
          try {
            const rescueFetch = Math.min(30, Math.max(limit + 5, 12));
            const rescue = await searchWithFallback({
              query: query.trim(),
              queries: [query.trim(), ...rescueQueries],
              fetchLimit: rescueFetch,
              searchType: search_type,
              searchMode: search_mode,
              includeReplies: include_replies,
              since,
              until,
            });
            const relevantRescue = keepRescueRelevant(rescue, query);
            attempts.push({
              actor: APIFY_FALLBACK_ACTOR,
              status: "ok",
              stage: "zero_result_rescue",
              query_variants: [query.trim(), ...rescueQueries],
              requested_candidates: rescueFetch,
              raw_results: rescue.length,
              relevant_results: relevantRescue.length,
            });
            combined.push(...relevantRescue);
          } catch (err) {
            const exhausted = isApifyBudgetExhausted(err);
            if (exhausted) apifyBudgetExhausted = true;
            attempts.push({
              actor: APIFY_FALLBACK_ACTOR,
              status: "error",
              stage: "zero_result_rescue",
              error: err?.message || String(err),
              ...(exhausted ? { budget_exhausted: true } : {}),
            });
          }
        }
      }

      // When Apify itself reports HTTP 402 / exhausted monthly usage, switch
      // immediately to the reserve token source. Do not spend reserve credits
      // merely because an Actor has a temporary outage or returns few results.
      if (apifyBudgetExhausted) {
        try {
          const reserveQuery =
            search_mode === "TAG" && !query.trim().startsWith("#")
              ? `#${query.trim()}`
              : query.trim();
          const reserve = await limitedTokenThreadsSearch({
            query: reserveQuery,
            since,
            until,
          });
          let reservePosts = reserve.rows.map(normalizeLimitedTokenPost);
          if (!include_replies) reservePosts = reservePosts.filter((p) => !p.is_reply);
          if (min_likes > 0) reservePosts = reservePosts.filter((p) => p.like_count >= min_likes);
          usedLimitedToken = true;
          limitedCreditsRemaining = reserve.creditsRemaining;
          attempts.push({
            source: "Limited Token Creator",
            status: "ok",
            results: reservePosts.length,
            credits_charged: reserve.creditsCharged,
            credits_remaining: reserve.creditsRemaining,
          });
          combined.push(...reservePosts);
        } catch (err) {
          attempts.push({
            source: "Limited Token Creator",
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

      // Cache the full candidate pool before the final slice. A DEEP cache can
      // satisfy later BALANCED/ECONOMY requests without another Apify run.
      setCachedSearch(key, resolvedQualityMode, posts, {
        usedLimitedToken,
        limitedCreditsRemaining,
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
                  error: apifyBudgetExhausted
                    ? "Primary search sudah mencapai batas penggunaan dan Limited Token Creator tidak dapat memberikan hasil."
                    : "Kedua primary search Actor gagal.",
                  attempts,
                  hint: apifyBudgetExhausted
                    ? "Pastikan SCRAPECREATORS_API_KEY sudah ada dan Limited Token Creator masih memiliki kredit."
                    : "Cek APIFY_TOKEN atau status Actor di Apify Console.",
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
                provider: usedLimitedToken ? "Limited Token Creator" : "Primary public Threads search",
                ...(usedLimitedToken ? { notice: LIMITED_TOKEN_NOTICE } : {}),
                quality_mode_requested: quality_mode,
                quality_mode_resolved: resolvedQualityMode,
                cache_hit: false,
                cache_ttl_seconds: Math.round(ttlMs / 1000),
                candidate_plan: plan,
                search_type,
                search_mode,
                sort_by,
                returned: posts.length,
                attempts,
                coverage_status: posts.length === 0 ? "NO_RESULTS_FROM_PUBLIC_SEARCH_SOURCES" : "PARTIAL_PUBLIC_SEARCH",
                coverage_warning:
                  "PENTING: 0 hasil dari scraper publik TIDAK berarti tidak ada postingan di Threads. Pencarian manual saat login dapat menampilkan hasil yang tidak diekspos ke pengunjung logged-out. Jangan menyimpulkan topik tidak ada hanya dari returned=0.",
                note: usedLimitedToken
                  ? "Primary search sudah mencapai batas penggunaan. Limited Token Creator dipakai otomatis untuk request ini. Sumber cadangan ini maksimal sekitar 10 hasil per keyword dalam satu request."
                  : "MCP sudah mencoba pencarian publik dan zero-result rescue. Hasil tetap bisa tidak lengkap dibanding pencarian manual di aplikasi Threads saat login.",
                ...(usedLimitedToken && limitedCreditsRemaining !== null
                  ? { limited_token_credits_remaining: limitedCreditsRemaining }
                  : {}),
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
        limited_token_configured: Boolean(LIMITED_TOKEN_API_KEY),
        tests: [],
      };
      if (!APIFY_TOKEN) {
        report.tests.push({ status: "error", error: "APIFY_TOKEN missing" });
        return { isError: true, content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
      }

      try {
        const rows = await searchWithPrimary({
          query,
          fetchLimit: 3,
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
            fetchLimit: 3,
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
