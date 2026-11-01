/**
 * Author marketing / spam flags shared by Strike Ledger and the bookmark library.
 *
 * Source of truth: chrome.storage.local key `xsl` (the strike ledger).
 *   - explicit flags: ledger[userId].authorFlags.{marketing,spam}
 *   - strike counts: ledger[userId].tags (Spam / Marketing)
 *   - settings: settings.libraryChipFromStrikes, libraryChipThreshold, bookmarkMarkAddsStrike
 * The public index (`xsl.index`) copies authorFlags and tag counts so the library
 * can read them without the evidence blobs. There is no second map in bk_* and
 * no Dexie authors table. Chips are derived by libraryMarksForAccount.
 * This module never enqueues mute or block.
 */

export const AUTHOR_FLAG_STORE = {
  area: "chrome.storage.local",
  key: "xsl",
  accountField: "ledger[userId].authorFlags",
  indexField: "index[userId].authorFlags",
  settings: ["libraryChipFromStrikes", "libraryChipThreshold", "bookmarkMarkAddsStrike"],
};

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function cleanHandle(value) {
  const s = String(value || "").trim().replace(/^@+/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(s)) return "";
  return s;
}

export function emptyAuthorFlags() {
  return { marketing: false, spam: false };
}

export function normalizeAuthorFlags(raw) {
  return {
    marketing: raw?.marketing === true,
    spam: raw?.spam === true,
  };
}

/** Separate from the mute/block tag threshold. Default 3. */
export function libraryChipThreshold(settings) {
  return clampInt(settings?.libraryChipThreshold, 1, 99, 3);
}

/** Default on: existing strike counts light the library chip. */
export function libraryChipFromStrikes(settings) {
  return settings?.libraryChipFromStrikes !== false;
}

export function authorLinkSettings(settings) {
  return {
    libraryChipFromStrikes: libraryChipFromStrikes(settings),
    libraryChipThreshold: libraryChipThreshold(settings),
    bookmarkMarkAddsStrike: settings?.bookmarkMarkAddsStrike === true,
  };
}

function countsOf(account) {
  const counts = { Spam: 0, Marketing: 0 };
  if (Array.isArray(account?.tags)) {
    for (const tag of account.tags) {
      if (tag?.name === "Spam" || tag?.name === "Marketing") counts[tag.name] = tag.count || 0;
    }
  }
  const extra = account?.counts;
  if (extra && typeof extra === "object") {
    if (counts.Spam === 0 && extra.Spam) counts.Spam = extra.Spam || 0;
    if (counts.Marketing === 0 && extra.Marketing) counts.Marketing = extra.Marketing || 0;
  }
  return counts;
}

/**
 * Library chips for one ledger account or index row.
 * Explicit authorFlags always count. Strike counts count only when
 * libraryChipFromStrikes is on and the tag count reaches libraryChipThreshold.
 * Whitelist and follow state do not hide the chip. Nothing here queues mute/block.
 */
export function libraryMarksForAccount(account, settings) {
  const explicit = normalizeAuthorFlags(account?.authorFlags);
  const threshold = libraryChipThreshold(settings);
  const fromStrikesOn = libraryChipFromStrikes(settings);
  const counts = countsOf(account);
  const fromStrike = {
    spam: fromStrikesOn && counts.Spam >= threshold,
    marketing: fromStrikesOn && counts.Marketing >= threshold,
  };
  return {
    userId: account?.userId ? String(account.userId) : "",
    handle: cleanHandle(account?.handle).toLowerCase(),
    spam: explicit.spam || fromStrike.spam,
    marketing: explicit.marketing || fromStrike.marketing,
    explicit,
    fromStrike,
    counts,
    threshold,
  };
}

export function mergeMarkRecords(parts) {
  const explicit = { marketing: false, spam: false };
  const fromStrike = { marketing: false, spam: false };
  const counts = { Spam: 0, Marketing: 0 };
  let threshold = 3;
  let userId = "";
  let handle = "";
  for (const part of parts || []) {
    if (!part) continue;
    explicit.marketing = explicit.marketing || !!part.explicit?.marketing;
    explicit.spam = explicit.spam || !!part.explicit?.spam;
    fromStrike.marketing = fromStrike.marketing || !!part.fromStrike?.marketing;
    fromStrike.spam = fromStrike.spam || !!part.fromStrike?.spam;
    counts.Spam = Math.max(counts.Spam, part.counts?.Spam || 0);
    counts.Marketing = Math.max(counts.Marketing, part.counts?.Marketing || 0);
    if (part.threshold) threshold = part.threshold;
    userId = userId || part.userId || "";
    handle = handle || part.handle || "";
  }
  return {
    userId,
    handle,
    spam: explicit.spam || fromStrike.spam,
    marketing: explicit.marketing || fromStrike.marketing,
    explicit,
    fromStrike,
    counts,
    threshold,
  };
}

/** Build a lookup from `xsl.index` (or any userId → row map) plus settings. */
export function authorMarkLookup(index, settings) {
  const byUserId = new Map();
  const byHandle = new Map();
  const rows = index && typeof index === "object" ? Object.entries(index) : [];
  for (const [userId, row] of rows) {
    if (!row || typeof row !== "object") continue;
    const handle = cleanHandle(row.handle || (String(userId).startsWith("h:") ? String(userId).slice(2) : ""));
    const marks = libraryMarksForAccount({ ...row, userId, handle }, settings);
    byUserId.set(String(userId), marks);
    if (!marks.handle) continue;
    const prev = byHandle.get(marks.handle);
    byHandle.set(marks.handle, prev ? mergeMarkRecords([prev, marks]) : marks);
  }
  return { byUserId, byHandle };
}

export function marksForPost(post, lookup) {
  if (!lookup) return mergeMarkRecords([]);
  const uid = String(post?.user_id || post?.userId || "").trim();
  const handle = cleanHandle(post?.screen_name || post?.handle || "").toLowerCase();
  const parts = [];
  if (uid && lookup.byUserId?.get) {
    const hit = lookup.byUserId.get(uid);
    if (hit) parts.push(hit);
  }
  if (handle && lookup.byUserId?.get) {
    const hit = lookup.byUserId.get(`h:${handle}`);
    if (hit) parts.push(hit);
  }
  if (handle && lookup.byHandle?.get) {
    const hit = lookup.byHandle.get(handle);
    if (hit) parts.push(hit);
  }
  return mergeMarkRecords(parts);
}

/** author: / strike: token. Marketing and spam aliases in zh and en. */
export function authorMarkKind(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "marketing" || v === "市场" || v === "营销" || v === "常营销") return "marketing";
  if (v === "spam" || v === "垃圾" || v === "常垃圾") return "spam";
  if (v === "any" || v === "all" || v === "either" || v === "全部" || v === "任一") return "any";
  return "";
}

function kindHits(marks, kind) {
  if (kind === "any") return !!(marks.marketing || marks.spam);
  if (kind === "marketing") return !!marks.marketing;
  if (kind === "spam") return !!marks.spam;
  return false;
}

/** Every requested kind must match (AND). Empty list matches everything. */
export function postMatchesAuthorMarks(post, lookup, kinds) {
  if (!kinds?.length) return true;
  const marks = marksForPost(post, lookup);
  return kinds.every((kind) => kindHits(marks, kind));
}

/** True when the post should be excluded by a negated author:/strike: token. */
export function postExcludedByAuthorMarks(post, lookup, kinds) {
  if (!kinds?.length) return false;
  const marks = marksForPost(post, lookup);
  return kinds.some((kind) => kindHits(marks, kind));
}

/**
 * One op per author. Bulk selection of many posts by the same author
 * sets the flag once and carries a single tweet id (so a strike, if enabled,
 * is added at most once).
 */
export function distinctAuthorFlagOps(posts, flag, value) {
  const kind = flag === "spam" ? "spam" : flag === "marketing" ? "marketing" : "";
  if (!kind) return [];
  const seen = new Set();
  const ops = [];
  for (const post of posts || []) {
    const handle = cleanHandle(post?.screen_name || post?.handle || "");
    const userId = String(post?.user_id || post?.userId || "").trim();
    const handleKey = handle.toLowerCase();
    if (!userId && !handleKey) continue;
    if ((userId && seen.has(`id:${userId}`)) || (handleKey && seen.has(`h:${handleKey}`))) continue;
    if (userId) seen.add(`id:${userId}`);
    if (handleKey) seen.add(`h:${handleKey}`);
    ops.push({
      userId,
      handle,
      displayName: String(post?.name || post?.displayName || "").slice(0, 80),
      flag: kind,
      value: !!value,
      tweetId: String(post?.tweet_id || post?.tweetId || ""),
      url: String(post?.url || ""),
      textSnippet: String(post?.text || post?.textSnippet || ""),
    });
  }
  return ops;
}
