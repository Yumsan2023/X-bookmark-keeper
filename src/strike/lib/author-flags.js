/**
 * Author marketing / spam flags shared by Strike Ledger and the bookmark library.
 *
 * Source of truth: chrome.storage.local key `xsl` (the strike ledger).
 *   - explicit flags: ledger[userId].authorFlags.{marketing,spam}
 *   - strike counts: ledger[userId].tags (Spam / Marketing)
 *   - settings: settings.libraryChipFromStrikes, libraryChipThreshold, bookmarkMarkAddsStrike
 *   - display only: settings.tagEffects (chip / none / outline / fold)
 * The public index (`xsl.index`) copies authorFlags and tag counts so the library
 * can read them without the evidence blobs. There is no second map in bk_* and
 * no Dexie authors table. Chips are derived by libraryMarksForAccount.
 * Tag effects change paint only. They do not add strikes, enqueue mute or block,
 * or change whitelist, follow, or community-list decisions.
 * This module never enqueues mute or block.
 */

export const AUTHOR_FLAG_STORE = {
  area: "chrome.storage.local",
  key: "xsl",
  accountField: "ledger[userId].authorFlags",
  indexField: "index[userId].authorFlags",
  settings: ["libraryChipFromStrikes", "libraryChipThreshold", "bookmarkMarkAddsStrike", "tagEffects"],
};

/** Per-tag paint. Missing or unknown values stay on the existing chip colors. */
export const TAG_EFFECT_IDS = ["none", "chip", "outline", "fold"];
export const DEFAULT_TAG_EFFECT = "chip";

function effectKey(name) {
  const raw = String(name || "").trim().replace(/\s+/g, " ");
  if (!raw) return "";
  if (/^spam$/i.test(raw)) return "Spam";
  if (/^marketing$/i.test(raw)) return "Marketing";
  return raw.slice(0, 24);
}

/** Resolved effect for one canonical tag. Default is the current colored chip. */
export function tagEffectFor(settings, name) {
  const tag = effectKey(name);
  if (!tag) return DEFAULT_TAG_EFFECT;
  const raw = settings?.tagEffects?.[tag];
  return TAG_EFFECT_IDS.includes(raw) ? raw : DEFAULT_TAG_EFFECT;
}

/** spam / marketing / custom. Used for borders and the collapse bar, not for queueing. */
export function tagEffectTone(name) {
  const tag = effectKey(name);
  if (tag === "Spam") return "spam";
  if (tag === "Marketing") return "marketing";
  return tag ? "custom" : "";
}

/**
 * Keep only known effects for Spam, Marketing, and the caller's custom tags.
 * The default chip effect is omitted so older ledgers stay unchanged.
 */
export function sanitizeTagEffects(raw, allowed) {
  const keep = new Set(allowed || []);
  const next = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return next;
  for (const [name, value] of Object.entries(raw)) {
    const tag = effectKey(name);
    if (!tag || !keep.has(tag)) continue;
    if (!TAG_EFFECT_IDS.includes(value) || value === DEFAULT_TAG_EFFECT) continue;
    next[tag] = value;
  }
  return next;
}

function toneRank(tone) {
  if (tone === "spam") return 0;
  if (tone === "marketing") return 1;
  return 2;
}

/**
 * Attach a display effect to timeline/comment chips.
 * `outline` is the one card accent: Spam, then Marketing, then the first custom chip.
 * Does not read or write strike counts.
 */
export function decorateTagChips(chips, settings) {
  const list = Array.isArray(chips) ? chips : [];
  const next = list.map((chip) => {
    if (!chip || chip.more || !chip.name) return { ...(chip || {}), effect: "none" };
    return { ...chip, effect: tagEffectFor(settings, chip.name) };
  });
  let outline = "";
  let best = 99;
  let bestIndex = 99;
  next.forEach((chip, index) => {
    if (!chip || chip.more || chip.effect !== "outline") return;
    const tone = tagEffectTone(chip.name);
    const rank = toneRank(tone);
    if (rank < best || (rank === best && index < bestIndex)) {
      best = rank;
      bestIndex = index;
      outline = tone;
    }
  });
  return { chips: next, outline };
}

/** Collapse-bar accent for a tag whose effect is fold. Empty means the existing orange bar. */
export function foldAccent(settings, tag) {
  const name = effectKey(tag);
  if (!name || tagEffectFor(settings, name) !== "fold") return "";
  return tagEffectTone(name);
}

/**
 * Bookmark author chips share the Spam / Marketing effect.
 * Fold has no bar in the library, so the chip stays colored.
 * Outline prefers spam when both chips ask for a card edge.
 */
export function libraryAuthorDecor(marks, settings) {
  const spamOn = !!marks?.spam;
  const marketingOn = !!marks?.marketing;
  const spamEffect = tagEffectFor(settings, "Spam");
  const marketingEffect = tagEffectFor(settings, "Marketing");
  let outline = "";
  if (spamOn && spamEffect === "outline") outline = "spam";
  else if (marketingOn && marketingEffect === "outline") outline = "marketing";
  return {
    spamEffect: spamOn ? spamEffect : "",
    marketingEffect: marketingOn ? marketingEffect : "",
    outline,
  };
}

export function bookmarkOutlineClass(marks, settings) {
  const outline = libraryAuthorDecor(marks, settings).outline;
  return outline ? `fx-outline-${outline}` : "";
}

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
    tagEffects: {
      Spam: tagEffectFor(settings, "Spam"),
      Marketing: tagEffectFor(settings, "Marketing"),
    },
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
