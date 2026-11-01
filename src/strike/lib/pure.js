/**
 * Pure ledger, rule, and shortcut logic.
 * No chrome.* and no DOM so Node tests and the service worker share one implementation.
 * Strike counts change only through applyMark / import / undo — never through
 * matchRules, addKeywordToPack, addDistilledRules, or recordRuleHits.
 */

export const SCHEMA = 1;
export const PRODUCT = "x-strike-ledger";
export const BUILTIN_TAGS = ["Spam", "Marketing"];
export const EVIDENCE_CAP = 30;
export const UNDO_CAP = 50;
export const LOG_CAP = 80;
export const HIT_LOG_CAP = 40;
export const QUEUE_MAX = 100;
export const QUEUE_ATTEMPTS = 4;
export const AI_CACHE_CAP = 400;
export const INFLIGHT_MS = 45_000;
/** Extra wait on top of the configured gap. Always at least one second. */
export const ACTION_JITTER_MIN_MS = 1000;
export const ACTION_JITTER_SPAN_MS = 1500;
export const BACKOFF_STEPS_MS = [30_000, 120_000, 480_000, 900_000];

let seq = 0;

export function uid(prefix = "id") {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function snippet(text, max = 180) {
  const s = String(text || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export function fold(value) {
  return String(value || "").normalize("NFKC").toLowerCase();
}

export function sanitizeHandle(value) {
  const s = String(value || "").trim().replace(/^@+/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(s)) return "";
  return s;
}

export function sanitizeName(value) {
  return snippet(value, 80);
}

export function canonicalTag(value) {
  const raw = String(value || "").trim().replace(/\s+/g, " ").slice(0, 24);
  if (!raw || /[\u0000-\u001f]/.test(raw)) return "";
  if (/^spam$/i.test(raw)) return "Spam";
  if (/^marketing$/i.test(raw)) return "Marketing";
  if (!/[\p{L}\p{N}]/u.test(raw)) return "";
  return raw;
}

export function accountIdFromHandle(handle) {
  return `h:${handle.toLowerCase()}`;
}

export function tagLabel(name, lang) {
  if (name === "Spam") return lang === "zh" ? "垃圾" : "Spam";
  if (name === "Marketing") return lang === "zh" ? "营销" : "Marketing";
  return name;
}

export function resolveLang(setting, navigatorLang = "en") {
  if (setting === "zh" || setting === "en") return setting;
  return String(navigatorLang || "en").toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function localDay(now) {
  const d = new Date(now);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

export function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Start-to-start gap before the next native menu click.
 * Floor is the configured minimum (at least 1s). Jitter adds another 1–2.5s
 * so a burst of queued mute/block actions cannot click in lockstep.
 * @param {number} rateLimitMs
 * @param {number | (() => number)} [random]
 * @returns {number}
 */
export function nextActionDelayMs(rateLimitMs, random = Math.random) {
  const floorMs = Math.max(1000, clampInt(rateLimitMs, 1000, 10000, 1200));
  const roll = typeof random === "function" ? Number(random()) : Number(random);
  const unit = Number.isFinite(roll) ? Math.min(1, Math.max(0, roll)) : 0;
  const jitter = ACTION_JITTER_MIN_MS + Math.floor(unit * ACTION_JITTER_SPAN_MS);
  return floorMs + jitter;
}

const RATE_LIMIT_RE = /(?:\b429\b|rate[\s-]?limit|too many requests|try again later|action limit|temporarily limited|限流|过于频繁|稍后再试|请求过多|操作过于频繁|超出速率)/i;

/** Page-notice classifier only. This does not call X. */
export function isRateLimitSignal(text) {
  return RATE_LIMIT_RE.test(String(text || ""));
}

export function backoffDelayMs(strikes) {
  const n = clampInt(strikes, 1, 20, 1);
  return BACKOFF_STEPS_MS[Math.min(n - 1, BACKOFF_STEPS_MS.length - 1)];
}

/**
 * Account and switches allow a mute/block to be queued.
 * Whitelist, following, and unknown follow state are refused.
 * Caller still has to honor auto vs confirm vs prompt-only.
 */
export function autoPlatformAllowed(settings, account, kind) {
  if (!settings?.enablePlatformActions) return false;
  if (!account || account.whitelist) return false;
  if (account.followed !== false) return false;
  if (kind === "mute") return !!settings.muteOnThreshold;
  if (kind === "block") return !!settings.blockOnThreshold;
  return false;
}

/** How many tag chips to paint before a “+N” overflow chip. */
export const CHIP_CAP = 4;

/**
 * Protect badge and persistent tag chips for one timeline author.
 * Display only — this does not enqueue mute or block. Following and
 * whitelist stay refused by autoPlatformAllowed; the badge only shows that.
 * `options.followed` is the live page state and wins over the stored flag.
 * @param {{ whitelist?: boolean, followed?: boolean | null, counts?: Record<string, number> }} [account]
 * @param {{ lang?: string, followed?: boolean | null, limit?: number }} [options]
 */
export function timelineChrome(account, options = {}) {
  const lang = options.lang === "zh" ? "zh" : "en";
  const live = options.followed;
  const stored = account?.followed;
  const followed = live === true || live === false
    ? live
    : stored === true ? true : stored === false ? false : null;
  const whitelist = !!account?.whitelist;
  let protect = null;
  if (followed === true || whitelist) {
    const reason = followed === true && whitelist ? "both" : followed === true ? "following" : "whitelist";
    const titleKey = reason === "both" ? "protectBoth" : reason === "whitelist" ? "protectWhitelist" : "protectFollowing";
    protect = {
      reason,
      titleKey,
      tone: "protect",
      text: lang === "zh" ? (followed === true ? "已关注保护" : "白名单保护") : "Protected",
    };
  }
  const counts = account?.counts && typeof account.counts === "object" ? account.counts : {};
  const merged = new Map();
  for (const [rawName, rawCount] of Object.entries(counts)) {
    const name = canonicalTag(rawName);
    const count = Math.floor(Number(rawCount));
    if (!name || !Number.isFinite(count) || count < 1) continue;
    merged.set(name, (merged.get(name) || 0) + count);
  }
  const rows = [...merged.entries()].map(([name, count]) => ({ name, count }));
  rows.sort((a, b) => {
    const rank = (name) => (name === "Spam" ? 0 : name === "Marketing" ? 1 : 2);
    const byRank = rank(a.name) - rank(b.name);
    if (byRank) return byRank;
    if (b.count !== a.count) return b.count - a.count;
    return a.name.localeCompare(b.name);
  });
  const limit = clampInt(options.limit, 1, 8, CHIP_CAP);
  const shown = rows.slice(0, limit);
  const extra = rows.length - shown.length;
  const chips = shown.map((row) => ({
    name: row.name,
    tone: row.name === "Spam" ? "spam" : row.name === "Marketing" ? "marketing" : "custom",
    count: row.count,
    text: `${tagLabel(row.name, lang)}×${row.count}`,
    more: false,
  }));
  if (extra > 0) {
    chips.push({ name: "", tone: "more", count: extra, text: `+${extra}`, more: true });
  }
  return { protect, chips };
}

export function contentHash(parts) {
  const text = (Array.isArray(parts) ? parts.join("\n") : String(parts ?? ""))
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const ch of text) {
    h ^= BigInt(ch.codePointAt(0));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

export function timeOf(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Date.parse(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function defaultKeywordPacks() {
  return [
    {
      id: "pack-spam-zh",
      name: "垃圾 / 诈骗（中文）",
      enabled: true,
      suggestTag: "Spam",
      patterns: [
        ["刷单", "网赌", "博彩", "赌场", "稳赚不赔", "带单", "合约信号", "杀猪盘", "裸聊", "发票代开", "无抵押贷款", "日入过万", "空投", "助记词", "种子短语", "私信返利", "关注回关", "互粉"].map((value) => ({
          type: "keyword",
          target: "any",
          value,
        })),
      ].flat(),
    },
    {
      id: "pack-mkt-zh",
      name: "营销引流（中文）",
      enabled: true,
      suggestTag: "Marketing",
      patterns: ["加微信", "加v", "薇信", "v信", "私信我", "私信领取", "引流", "进群", "限时优惠", "免费领取", "点击链接", "代购", "招商加盟", "割韭菜", "转发抽奖", "抽奖关注"].map((value) => ({
        type: "keyword",
        target: "any",
        value,
      })),
    },
    {
      id: "pack-spam-en",
      name: "Spam / scam (EN)",
      enabled: true,
      suggestTag: "Spam",
      patterns: [
        "airdrop",
        "free mint",
        "seed phrase",
        "recovery phrase",
        "guaranteed returns",
        "guaranteed profit",
        "signal group",
        "forex signals",
        "casino bonus",
        "whatsapp me",
        "dm to win",
        "double your",
        "wallet connect",
        "claim your airdrop",
      ].map((value) => ({ type: "keyword", target: "any", value })),
    },
    {
      id: "pack-mkt-en",
      name: "Marketing (EN)",
      enabled: true,
      suggestTag: "Marketing",
      patterns: [
        "link in bio",
        "promo code",
        "use my code",
        "use code",
        "affiliate link",
        "shop now",
        "limited time offer",
        "discount code",
        "check pinned",
        "tag 3 friends",
        "follow and rt",
        "giveaway",
      ].map((value) => ({ type: "keyword", target: "any", value })),
    },
    {
      id: "pack-contacts",
      name: "联系方式与短链 / Contacts & short links",
      enabled: true,
      suggestTag: "Spam",
      patterns: [
        { type: "regex", target: "any", value: "(?i)t\\.me/[a-z0-9_]{3,}" },
        { type: "regex", target: "any", value: "(?i)wa\\.me/[0-9]{6,}" },
        { type: "regex", target: "any", value: "(?i)bit\\.ly/[a-z0-9]+" },
        { type: "regex", target: "any", value: "(?i)tinyurl\\.com/[a-z0-9]+" },
        { type: "regex", target: "any", value: "(?i)(微信|薇信|vx|v信)\\s*[:：]?\\s*[a-z0-9_-]{4,}" },
        { type: "regex", target: "text", value: "(?i)\\b(dm|pm)\\s+me\\b" },
        { type: "regex", target: "text", value: "日[入赚]\\s*[0-9０-９千万]+" },
      ],
    },
    {
      id: "pack-handle",
      name: "可疑用户名 / Suspicious handles",
      enabled: false,
      suggestTag: "Spam",
      patterns: [{ type: "regex", target: "handle", value: "(?i)(airdrop|giveaway|casino|signals?|promo\\d{2,})" }],
    },
  ];
}

export function defaultSettings() {
  return {
    language: "auto",
    defaultThreshold: 3,
    tagThresholds: { Spam: 3, Marketing: 3 },
    actionMode: "confirm",
    hideOnThreshold: true,
    muteOnThreshold: false,
    blockOnThreshold: false,
    enablePlatformActions: false,
    dailyCap: 20,
    rateLimitMs: 1200,
    rulesEnabled: true,
    hitHistory: false,
    ai: {
      enabled: false,
      autoSuggestSuspects: false,
      endpoint: "https://api.openai.com/v1/chat/completions",
      model: "gpt-4o-mini",
      apiKey: "",
      hasApiKey: false,
    },
    shortcuts: {
      spam: "Alt+S",
      marketing: "Alt+M",
      picker: "Alt+T",
    },
    customTags: [],
    keywordPacks: defaultKeywordPacks(),
  };
}

export function freshState(now = Date.now()) {
  return {
    schema: SCHEMA,
    settings: defaultSettings(),
    ledger: {},
    tweets: {},
    hidden: {},
    queue: [],
    log: [],
    undo: [],
    aiCache: {},
    hitLog: [],
    rate: { day: localDay(now), count: 0, nextAllowed: 0, paused: false, backoffUntil: 0, lastError: "", rateStrikes: 0 },
    index: {},
    tweetTags: {},
  };
}

export function thresholdFor(settings, tag) {
  const raw = settings?.tagThresholds?.[tag];
  const n = Number.isFinite(Number(raw)) ? Number(raw) : settings?.defaultThreshold;
  return clampInt(n, 1, 99, 3);
}

export function oppositeAction(type) {
  switch (type) {
    case "mute":
      return "unmute";
    case "unmute":
      return "mute";
    case "block":
      return "unblock";
    case "unblock":
      return "block";
    default:
      return "";
  }
}

export function menuTestIds(kind) {
  switch (kind) {
    case "mute":
      return ["mute", "muteLink"];
    case "unmute":
      return ["unmute"];
    case "block":
      return ["block"];
    case "unblock":
      return ["unblock"];
    default:
      return [];
  }
}

const MENU_RULES = {
  mute: [/^mute(?:\s|@|$)/i, /^隐藏(?:\s|@|$)/, /^静音(?:\s|@|$)/],
  unmute: [/^unmute(?:\s|@|$)/i, /^取消隐藏/, /^取消静音/],
  block: [/^block(?:\s|@|$)/i, /^屏蔽(?:\s|@|$)/, /^拉黑(?:\s|@|$)/],
  unblock: [/^unblock(?:\s|@|$)/i, /^取消屏蔽/, /^解除屏蔽/, /^取消拉黑/],
};

export function matchMenuLabel(raw, kind, handle) {
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  if (!text || !MENU_RULES[kind]) return false;
  if (/mute words|add muted|隐藏字词|隐藏回复|not interested|不感兴趣|\breport\b|举报|\blists?\b|列表|\banalytics\b|查看分析|\bembed\b|嵌入|community note|社区备注|follow @|关注 @|移除粉丝|remove follower|this conversation|此对话|关键词/i.test(text)) {
    return false;
  }
  if (!MENU_RULES[kind].some((re) => re.test(text))) return false;
  const mentions = [...text.matchAll(/@([A-Za-z0-9_]{1,15})/g)].map((m) => m[1].toLowerCase());
  const h = String(handle || "").toLowerCase();
  if (mentions.length && h && !mentions.includes(h)) return false;
  return true;
}

export function parseShortcutString(str) {
  const parts = String(str || "")
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  let alt = false;
  let ctrl = false;
  let shift = false;
  let meta = false;
  let key = "";
  for (const part of parts) {
    const token = part.toLowerCase();
    if (token === "alt" || token === "option") alt = true;
    else if (token === "ctrl" || token === "control") ctrl = true;
    else if (token === "shift") shift = true;
    else if (token === "meta" || token === "cmd" || token === "command") meta = true;
    else if (!key && /^[a-z0-9]$/i.test(part)) key = part.toUpperCase();
    else return null;
  }
  if (!key || !(alt || ctrl || shift || meta)) return null;
  return { alt, ctrl, shift, meta, key };
}

export function formatShortcut(spec) {
  const parts = [];
  if (spec.ctrl) parts.push("Ctrl");
  if (spec.alt) parts.push("Alt");
  if (spec.shift) parts.push("Shift");
  if (spec.meta) parts.push("Meta");
  parts.push(spec.key.toUpperCase());
  return parts.join("+");
}

export function shortcutFromEvent(event) {
  if (!event || event.repeat) return null;
  let key = "";
  if (/^Key[A-Z]$/.test(event.code || "")) key = event.code.slice(3);
  else if (/^Digit[0-9]$/.test(event.code || "")) key = event.code.slice(5);
  else return null;
  const spec = {
    alt: !!event.altKey,
    ctrl: !!event.ctrlKey,
    shift: !!event.shiftKey,
    meta: !!event.metaKey,
    key,
  };
  if (!(spec.alt || spec.ctrl || spec.shift || spec.meta)) return null;
  return formatShortcut(spec);
}

export function eventMatchesShortcut(event, shortcut) {
  const spec = typeof shortcut === "string" ? parseShortcutString(shortcut) : shortcut;
  if (!event || !spec || event.repeat) return false;
  if (!!event.altKey !== !!spec.alt) return false;
  if (!!event.ctrlKey !== !!spec.ctrl) return false;
  if (!!event.shiftKey !== !!spec.shift) return false;
  if (!!event.metaKey !== !!spec.meta) return false;
  const code = event.code || "";
  if (/^Key[A-Z]$/.test(code)) return code.slice(3) === spec.key.toUpperCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5) === spec.key;
  return String(event.key || "").toUpperCase() === spec.key.toUpperCase();
}

export function isTypingTarget(target) {
  if (!target) return false;
  const el = target.nodeType === 1 ? target : target.parentElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return !!el.closest?.('[contenteditable="true"], input, textarea, select');
}

function isCatastrophic(source) {
  if (source.length > 180) return true;
  if (/(\([^()]*[+*][^()]*\))\s*[+*{]/.test(source)) return true;
  if (/\(\?:[^)]*[+*][^)]*\)\s*[+*{]/.test(source)) return true;
  if (/(?:\(\.\*\)|\(\.\+\)|\(\.\*\?\)|\(\.\+\?\))[+*{]/.test(source)) return true;
  return false;
}

export function compileRegex(source) {
  let src = String(source || "");
  let flags = "";
  if (src.startsWith("(?i)")) {
    src = src.slice(4);
    flags = "i";
  }
  if (!src || src.length > 180 || isCatastrophic(src)) {
    throw new Error("unsafe-regex");
  }
  return new RegExp(src, flags);
}

function fieldText(target, ctx) {
  if (target === "text") return ctx.text || "";
  if (target === "handle") return ctx.handle || "";
  if (target === "bio") return ctx.bio || "";
  return [ctx.text, ctx.handle, ctx.bio].filter(Boolean).join("\n");
}

/**
 * Yellow-chip matching only. This function does not receive the ledger and
 * must not be wired to a counter.
 */
export function matchRules(packs, ctx) {
  const reasons = [];
  const tags = [];
  for (const pack of packs || []) {
    if (!pack || pack.enabled === false) continue;
    for (const pattern of pack.patterns || []) {
      const value = String(pattern.value || "").trim();
      if (!value) continue;
      const target = pattern.target || "any";
      const hay = fieldText(target, ctx || {});
      if (!hay) continue;
      let hit = false;
      if (pattern.type === "regex") {
        try {
          hit = compileRegex(value).test(hay.slice(0, 2000));
        } catch {
          hit = false;
        }
      } else {
        hit = fold(hay).includes(fold(value));
      }
      if (!hit) continue;
      reasons.push({
        packId: pack.id,
        packName: pack.name,
        suggestTag: canonicalTag(pack.suggestTag) || "",
        pattern: value.slice(0, 80),
        target,
      });
      const tag = canonicalTag(pack.suggestTag);
      if (tag && !tags.includes(tag)) tags.push(tag);
      break;
    }
  }
  return { suspect: reasons.length > 0, tags, reasons };
}

const KEYWORD_TARGETS = ["text", "handle", "bio", "any"];

/**
 * A word taken from a tweet. Stored as a literal keyword, never as a regex.
 */
export function normalizeKeyword(raw) {
  const value = String(raw || "").replace(/\s+/g, " ").trim();
  if (!value) return { ok: false, error: "empty-keyword" };
  if (value.length > 80) return { ok: false, error: "keyword-long" };
  if (!/[\p{L}\p{N}]/u.test(value)) return { ok: false, error: "keyword-plain" };
  return { ok: true, value };
}

/**
 * Append one keyword to an existing pack. Does not read or write the ledger.
 */
export function addKeywordToPack(state, input) {
  const keyword = normalizeKeyword(input?.value);
  if (!keyword.ok) return keyword;
  const target = KEYWORD_TARGETS.includes(input?.target) ? input.target : "text";
  const packId = String(input?.packId || "").slice(0, 40);
  const pack = (state?.settings?.keywordPacks || []).find((item) => item.id === packId);
  if (!pack) return { ok: false, error: "no-pack" };
  if (!Array.isArray(pack.patterns)) pack.patterns = [];
  const folded = fold(keyword.value);
  const duplicate = (pack.patterns || []).some((pattern) =>
    pattern?.type !== "regex" && (pattern?.target || "any") === target && fold(pattern?.value) === folded);
  if (duplicate) {
    return { ok: true, duplicate: true, packId: pack.id, packName: pack.name, value: keyword.value };
  }
  if ((pack.patterns || []).length >= 80) return { ok: false, error: "pack-full" };
  pack.patterns.push({ type: "keyword", target, value: keyword.value });
  return { ok: true, duplicate: false, packId: pack.id, packName: pack.name, value: keyword.value };
}

function packHeaderName(name) {
  const cleaned = String(name || "pack").replace(/[[\]]/g, "").trim();
  return cleaned.slice(0, 40) || "pack";
}

function patternToLine(pattern) {
  const target = KEYWORD_TARGETS.includes(pattern?.target) ? pattern.target : "any";
  const value = String(pattern?.value || "").trim();
  if (!value) return "";
  if (pattern?.type === "regex") {
    let body = value;
    let flags = "";
    if (body.startsWith("(?i)")) {
      body = body.slice(4);
      flags = "i";
    }
    const prefix = target === "any" ? "" : `${target}:`;
    return `${prefix}/${body}/${flags}`;
  }
  if (target === "any") return value;
  return `${target}: ${value}`;
}

const PACK_TEXT_HEADER = [
  "# X Toolkit keyword packs",
  "# [Pack name] starts a pack. The next lines may be id:, enabled: true|false, suggest: Spam|Marketing|none.",
  "# A bare line is a keyword for any field. text: / handle: / bio: limit the field.",
  "# /pattern/i is a regex (optional i flag). Field form: text:/pattern/i",
  "# A file with no [pack] header becomes one pack named Imported.",
  "# Apply replaces the packs in the form. Save to keep them.",
  "# A match only paints the Suspect chip. It never adds a strike.",
].join("\n");

export function packsToText(packs) {
  const blocks = [];
  for (const pack of packs || []) {
    const lines = [`[${packHeaderName(pack?.name)}]`];
    const id = String(pack?.id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
    if (id) lines.push(`id: ${id}`);
    lines.push(`enabled: ${pack?.enabled === false ? "false" : "true"}`);
    const suggest = pack?.suggestTag === "Marketing" || pack?.suggestTag === "Spam" ? pack.suggestTag : "none";
    lines.push(`suggest: ${suggest}`);
    for (const pattern of pack?.patterns || []) {
      const line = patternToLine(pattern);
      if (line) lines.push(line);
    }
    blocks.push(lines.join("\n"));
  }
  return `${PACK_TEXT_HEADER}\n\n${blocks.join("\n\n")}\n`;
}

function parsePatternLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const regexLine = trimmed.match(/^(?:(text|handle|bio|any):)?\/(.*)\/([i]?)$/);
  if (regexLine) {
    const body = regexLine[2];
    if (!body) return { error: "empty-regex" };
    const flags = regexLine[3] || "";
    return { type: "regex", target: regexLine[1] || "any", value: flags === "i" ? `(?i)${body}` : body };
  }
  const fieldLine = trimmed.match(/^(text|handle|bio|any):\s*(.+)$/);
  if (fieldLine) return { type: "keyword", target: fieldLine[1], value: fieldLine[2].trim() };
  return { type: "keyword", target: "any", value: trimmed };
}

/**
 * Text form of keyword packs. Round-trips packsToText(). A headerless word
 * list becomes a single enabled Spam pack named Imported.
 */
export function parseKeywordPackText(text) {
  const rawText = String(text || "").replace(/^\uFEFF/, "");
  if (rawText.length > 100_000) return { ok: false, error: "too-large", packs: [], warnings: [] };
  const warnings = [];
  const lines = rawText.split(/\r?\n/);
  const headers = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const header = trimmed.match(/^\[([^[\]]+)\]$/);
    if (header && header[1].trim()) headers.push({ index, name: header[1].trim() });
  });
  const rawPacks = [];
  const pushPatterns = (sourceLines, packName, meta) => {
    const patterns = [];
    let directives = !!meta;
    let id = meta?.id || "";
    let enabled = meta ? meta.enabled : true;
    let suggestTag = meta ? meta.suggestTag : "Spam";
    for (const line of sourceLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (directives) {
        const idMatch = trimmed.match(/^id:\s*([A-Za-z0-9_-]{1,40})$/);
        const enabledMatch = trimmed.match(/^enabled:\s*(true|false)$/);
        const suggestMatch = trimmed.match(/^suggest:\s*(Spam|Marketing|none)$/);
        if (idMatch) {
          id = idMatch[1];
          continue;
        }
        if (enabledMatch) {
          enabled = enabledMatch[1] === "true";
          continue;
        }
        if (suggestMatch) {
          suggestTag = suggestMatch[1] === "none" ? "" : suggestMatch[1];
          continue;
        }
        directives = false;
      }
      const pattern = parsePatternLine(trimmed);
      if (!pattern) continue;
      if (pattern.error) {
        warnings.push(`已忽略空正则（${packName}）`);
        continue;
      }
      patterns.push(pattern);
    }
    return { id, enabled, suggestTag, patterns };
  };
  if (!headers.length) {
    const parsed = pushPatterns(lines, "Imported", null);
    if (parsed.patterns.length) {
      rawPacks.push({ id: "pack-imported", name: "Imported", enabled: true, suggestTag: "Spam", patterns: parsed.patterns });
    }
  } else {
    headers.forEach((header, index) => {
      const end = index + 1 < headers.length ? headers[index + 1].index : lines.length;
      const parsed = pushPatterns(lines.slice(header.index + 1, end), header.name, { id: "", enabled: true, suggestTag: "" });
      rawPacks.push({
        id: parsed.id || undefined,
        name: header.name,
        enabled: parsed.enabled,
        suggestTag: parsed.suggestTag,
        patterns: parsed.patterns,
      });
    });
  }
  const packs = sanitizePacks(rawPacks, warnings);
  const used = new Set();
  for (const pack of packs) {
    let id = pack.id;
    while (used.has(id)) id = `${id.slice(0, 34)}-${used.size}`.slice(0, 40);
    used.add(id);
    pack.id = id;
  }
  return { ok: true, packs, warnings };
}

/**
 * Debug log for rule hits. Never increments a strike count.
 */
export function recordRuleHits(state, input, now) {
  if (!state?.settings?.hitHistory) return { ok: true, recorded: 0, skipped: "off" };
  const incoming = Array.isArray(input?.hits) ? input.hits.slice(0, 8) : [];
  const next = Array.isArray(state.hitLog) ? [...state.hitLog] : [];
  const seen = new Set(next.map((item) => `${item.tweetId}|${item.packId}|${item.pattern}`));
  let recorded = 0;
  for (const raw of incoming) {
    const pattern = snippet(raw?.pattern, 80);
    const packId = String(raw?.packId || "").slice(0, 40);
    const tweetId = String(raw?.tweetId || "").replace(/[^\w-]/g, "").slice(0, 40);
    if (!pattern || !packId || !tweetId) continue;
    const key = `${tweetId}|${packId}|${pattern}`;
    if (seen.has(key)) continue;
    seen.add(key);
    next.unshift({
      at: now,
      packId,
      packName: snippet(raw?.packName, 40),
      pattern,
      target: KEYWORD_TARGETS.includes(raw?.target) ? raw.target : "text",
      handle: sanitizeHandle(raw?.handle),
      tweetId,
      snippet: snippet(raw?.snippet, 80),
    });
    recorded += 1;
  }
  state.hitLog = next.slice(0, HIT_LOG_CAP);
  return { ok: true, recorded };
}

export function clearHitLog(state) {
  state.hitLog = [];
  return { ok: true };
}

function menuTitle(text) {
  return snippet(text, 80).replace(/%/g, "％");
}

export function keywordMenuPlan(packs, lang) {
  const zh = lang === "zh";
  const items = [];
  for (const pack of packs || []) {
    if (!pack?.id) continue;
    const name = snippet(pack.name || pack.id, 40).replace(/%/g, "％");
    const off = pack.enabled === false;
    const title = zh
      ? (off ? `加入「${name}」（已停用）` : `加入「${name}」`)
      : (off ? `Add to “${name}” (off)` : `Add to “${name}”`);
    items.push({
      id: `xsl-kw:${String(pack.id).slice(0, 40)}`,
      title: menuTitle(title),
      packId: String(pack.id).slice(0, 40),
    });
    if (items.length >= 30) break;
  }
  return {
    parentTitle: zh ? "把选中文字加入关键词包" : "Add selection to keyword pack",
    items,
  };
}

export const DISTILL_CAP = 6;

const DISTILL_STOP = new Set([
  "a", "an", "the", "and", "or", "to", "of", "for", "in", "on", "at", "is", "are", "was", "were", "be", "been", "am",
  "this", "that", "with", "you", "your", "me", "my", "we", "our", "from", "by", "it", "its", "as", "if", "not", "just",
  "now", "new", "get", "all", "out", "up", "so", "do", "can", "will", "have", "has", "but", "about", "into", "than",
  "then", "they", "them", "their", "his", "her", "she", "he", "i", "im", "rt", "http", "https", "www", "com", "co",
  "的", "了", "是", "在", "我", "你", "他", "她", "它", "我们", "你们", "他们", "和", "与", "或", "就", "也", "都", "很",
  "这", "那", "一个", "没有", "不是", "什么", "怎么", "可以", "因为", "所以", "如果", "但是", "还是", "以及",
  "吧", "吗", "呢", "啊", "哦", "嗯", "请", "把", "被", "给", "让", "又", "再", "已", "要", "会", "到", "去", "来",
  "上", "下", "中", "对", "等", "着", "这是", "那个", "这个",
]);

const DAILY_INCOME_RE = "日[入赚]\\s*[0-9０-９千万]+";
const DM_ME_RE = "(?i)\\b(dm|pm)\\s+me\\b";

function clip(value, max) {
  return String(value ?? "").slice(0, max);
}

function collapse(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isStop(value) {
  const parts = fold(value).split(/\s+/).filter(Boolean);
  return parts.length > 0 && parts.every((part) => DISTILL_STOP.has(part));
}

function findField(value, fields) {
  const needle = fold(collapse(value));
  if (needle.length < 2) return "";
  for (const key of ["text", "bio", "handle"]) {
    const hay = fold(collapse(fields[key] || ""));
    if (hay && hay.includes(needle)) return key;
  }
  return "";
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tightLinkRegex(raw) {
  const match = collapse(raw).match(/^(?:https?:\/\/)?(?:www\.)?((?:t\.me|wa\.me|bit\.ly|tinyurl\.com)\/[A-Za-z0-9_-]{3,32})$/i);
  if (!match) return "";
  return `(?i)${escapeRegex(match[1])}`;
}

/** Regexes distillSuggestion is allowed to store. Model-authored regex is not. */
export function isDistilledPattern(value) {
  const source = String(value || "");
  if (source === DAILY_INCOME_RE || source === DM_ME_RE) return true;
  return /^\(\?i\)(?:t\\\.me|wa\\\.me|bit\\\.ly|tinyurl\\\.com)\/[A-Za-z0-9_-]{3,32}$/.test(source);
}

function pushDistilled(rules, seen, rule) {
  if (!rule || rules.length >= DISTILL_CAP) return false;
  const key = `${rule.type}|${fold(rule.value)}`;
  if (seen.has(key)) return false;
  seen.add(key);
  rules.push(rule);
  return true;
}

function coveredByLonger(rules, value) {
  const needle = fold(collapse(value));
  return rules.some((rule) => rule.type === "keyword" && fold(rule.value) !== needle && fold(rule.value).includes(needle));
}

function quoteSpans(reason) {
  const text = String(reason || "");
  const out = [];
  const re = /["“「']([^"”」']{2,40})["”」']/g;
  let match;
  while ((match = re.exec(text))) out.push(match[1]);
  return out;
}

function keywordList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (typeof item === "string") out.push(item);
    else if (item && typeof item === "object" && item.type !== "regex" && typeof item.value === "string") out.push(item.value);
    if (out.length >= DISTILL_CAP) break;
  }
  return out;
}

function readModelKeywords(parsed) {
  return keywordList(parsed?.keywords)
    .map((item) => collapse(item).slice(0, 40))
    .filter((item) => item.length >= 2 && /[\p{L}\p{N}]/u.test(item));
}

function reasonPhrases(reason, fields) {
  const words = collapse(reason).match(/[A-Za-z][A-Za-z0-9']{2,}/g) || [];
  const hay = fold([fields.text, fields.bio].filter(Boolean).join("\n"));
  const phrases = [];
  for (let size = 4; size >= 2; size -= 1) {
    for (let index = 0; index + size <= words.length; index += 1) {
      const phrase = words.slice(index, index + size).join(" ");
      if (phrase.length > 40 || isStop(phrase)) continue;
      if (hay.includes(fold(phrase))) phrases.push(phrase);
    }
  }
  return phrases;
}

function structuralRules(text, target) {
  const source = String(text || "");
  const rules = [];
  const linkRe = /(?:https?:\/\/)?(?:www\.)?((?:t\.me|wa\.me|bit\.ly|tinyurl\.com)\/[A-Za-z0-9_-]{3,32})/gi;
  let match;
  while ((match = linkRe.exec(source))) {
    const value = tightLinkRegex(match[1]);
    if (value) rules.push({ type: "regex", target, value });
  }
  const contactRe = /(?:微信|薇信|vx|v信)\s*[:：]?\s*[A-Za-z0-9_-]{4,24}/gi;
  while ((match = contactRe.exec(source))) {
    const value = collapse(match[0]).slice(0, 40);
    if (value.length >= 2) rules.push({ type: "keyword", target, value });
  }
  if (new RegExp(DAILY_INCOME_RE).test(source)) rules.push({ type: "regex", target, value: DAILY_INCOME_RE });
  try {
    if (compileRegex(DM_ME_RE).test(source)) rules.push({ type: "regex", target, value: DM_ME_RE });
  } catch {
    /* fixed pattern */
  }
  return rules;
}

/**
 * Short rules from one spam/marketing suggestion.
 * A keyword is kept only when it literally occurs in the post, bio, or handle.
 * A regex is kept only for a fixed shape this post actually shows (short link,
 * 日入+金额, or "dm me"). Nothing here reads the ledger or calls a model.
 */
export function distillSuggestion(input) {
  const label = input?.label === "Spam" || input?.label === "Marketing" ? input.label : "";
  if (!label) return { ok: true, rules: [] };
  const fields = {
    text: clip(input?.text, 2000),
    bio: clip(input?.bio, 500),
    handle: sanitizeHandle(input?.handle),
  };
  const rules = [];
  const seen = new Set();
  const acceptLiteral = (raw) => {
    const collapsed = collapse(raw);
    if (!collapsed || collapsed.length > 40) return;
    const link = tightLinkRegex(collapsed);
    if (link) {
      const probe = collapsed.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
      const field = findField(probe, fields);
      if (!field || field === "handle") return;
      pushDistilled(rules, seen, { type: "regex", target: field, value: link });
      return;
    }
    if (collapsed.length < 2 || !/[\p{L}\p{N}]/u.test(collapsed) || isStop(collapsed)) return;
    if (fields.handle && fold(collapsed) === fold(fields.handle)) return;
    if (coveredByLonger(rules, collapsed)) return;
    const field = findField(collapsed, fields);
    if (!field) return;
    pushDistilled(rules, seen, { type: "keyword", target: field, value: collapsed });
  };

  for (const rule of structuralRules(fields.text, "text")) pushDistilled(rules, seen, rule);
  for (const rule of structuralRules(fields.bio, "bio")) pushDistilled(rules, seen, rule);
  for (const raw of keywordList(input?.keywords)) acceptLiteral(raw);
  for (const quote of quoteSpans(input?.reason)) acceptLiteral(quote);
  for (const phrase of reasonPhrases(input?.reason, fields)) acceptLiteral(phrase);

  const hanRuns = String(input?.reason || "").match(/[\p{Script=Han}]{2,12}/gu) || [];
  const cjk = [];
  hanRuns.forEach((run, runIndex) => {
    for (let size = Math.min(6, run.length); size >= 2; size -= 1) {
      for (let start = 0; start + size <= run.length; start += 1) {
        cjk.push({ runIndex, start, end: start + size, value: run.slice(start, start + size) });
      }
    }
  });
  cjk.sort((a, b) => b.value.length - a.value.length || a.start - b.start);
  const spans = [];
  for (const cand of cjk) {
    if (rules.length >= DISTILL_CAP) break;
    if (isStop(cand.value)) continue;
    if (spans.some((span) => span.runIndex === cand.runIndex && cand.start < span.end && cand.end > span.start)) continue;
    const before = rules.length;
    acceptLiteral(cand.value);
    if (rules.length > before) spans.push(cand);
  }

  for (const token of collapse(input?.reason).match(/[A-Za-z][A-Za-z0-9']{3,24}/g) || []) acceptLiteral(token);

  let tags = 0;
  for (const match of String(fields.text).matchAll(/#([\p{L}\p{N}_]{3,24})/gu)) {
    if (tags >= 2 || rules.length >= DISTILL_CAP) break;
    const before = rules.length;
    acceptLiteral(match[1]);
    if (rules.length > before) tags += 1;
  }
  return { ok: true, rules };
}

export function suggestPackId(packs, label) {
  const list = Array.isArray(packs) ? packs : [];
  const enabled = list.filter((pack) => pack && pack.id && pack.enabled !== false);
  const tagged = enabled.find((pack) => pack.suggestTag === label);
  const pick = tagged || enabled[0] || list.find((pack) => pack?.id);
  return pick?.id ? String(pick.id).slice(0, 40) : "";
}

function normalizeDistilledRule(raw) {
  const target = KEYWORD_TARGETS.includes(raw?.target) ? raw.target : "";
  if (!target) return null;
  if (raw?.type === "regex") {
    const value = String(raw.value || "");
    if (!isDistilledPattern(value)) return null;
    try {
      compileRegex(value);
    } catch {
      return null;
    }
    return { type: "regex", target, value };
  }
  const keyword = normalizeKeyword(raw?.value);
  if (!keyword.ok || keyword.value.length < 2 || keyword.value.length > 40 || isStop(keyword.value)) return null;
  return { type: "keyword", target, value: keyword.value };
}

/**
 * Copy distilled rules into one existing pack.
 * Pass `rules` to keep a confirmed subset. Each kept rule must still match a
 * fresh distill of this same post, so a caller cannot sneak in an extra pattern.
 * Strike counts, the queue, and the AI key are left untouched.
 */
export function addDistilledRules(state, input) {
  const packId = String(input?.packId || "").slice(0, 40);
  const pack = (state?.settings?.keywordPacks || []).find((item) => item.id === packId);
  if (!pack) return { ok: false, error: "no-pack" };
  const pool = distillSuggestion(input).rules;
  const poolKeys = new Set(pool.map((rule) => `${rule.type}|${rule.target}|${fold(rule.value)}`));
  const selected = Array.isArray(input?.rules) ? input.rules.slice(0, DISTILL_CAP) : pool;
  const chosen = [];
  const chosenKeys = new Set();
  for (const raw of selected) {
    const clean = normalizeDistilledRule(raw);
    if (!clean) continue;
    const key = `${clean.type}|${clean.target}|${fold(clean.value)}`;
    if (!poolKeys.has(key) || chosenKeys.has(key)) continue;
    chosenKeys.add(key);
    chosen.push(clean);
  }
  if (!chosen.length) return { ok: false, error: "empty-keyword" };
  if (!Array.isArray(pack.patterns)) pack.patterns = [];
  const added = [];
  const duplicates = [];
  let stopped = "";
  for (const rule of chosen) {
    if (pack.patterns.length >= 80) {
      stopped = "pack-full";
      break;
    }
    const duplicate = pack.patterns.some((pattern) =>
      pattern?.type === rule.type && (pattern?.target || "any") === rule.target && fold(pattern?.value) === fold(rule.value));
    if (duplicate) {
      duplicates.push(rule);
      continue;
    }
    pack.patterns.push({ type: rule.type, target: rule.target, value: rule.value });
    added.push(rule);
  }
  if (!added.length && stopped) return { ok: false, error: "pack-full" };
  return {
    ok: true,
    packId: pack.id,
    packName: pack.name,
    added,
    duplicates,
    count: added.length,
    duplicate: added.length === 0 && duplicates.length > 0,
    stopped,
  };
}

export function interpretAiLabel(content) {
  if (!content) return { label: null, reason: "", verdict: "invalid", keywords: [] };
  let text = String(content).trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        parsed = null;
      }
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { label: null, reason: "", verdict: "invalid", keywords: [] };
  }
  const raw = String(parsed.label || parsed.tag || "").trim().toLowerCase();
  let label = null;
  let verdict = "invalid";
  if (raw === "spam" || raw === "垃圾") {
    label = "Spam";
    verdict = "tag";
  } else if (raw === "marketing" || raw === "营销") {
    label = "Marketing";
    verdict = "tag";
  } else if (raw === "none" || raw === "other" || raw === "no") {
    verdict = "none";
  }
  return { label, reason: snippet(parsed.reason || "", 140), verdict, keywords: readModelKeywords(parsed) };
}

export function allowedAiEndpoint(raw) {
  try {
    const url = new URL(String(raw || ""));
    if (url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) return true;
    return false;
  } catch {
    return false;
  }
}

function sanitizePattern(raw, warnings, packName) {
  const type = raw?.type === "regex" ? "regex" : "keyword";
  const target = ["text", "handle", "bio", "any"].includes(raw?.target) ? raw.target : "any";
  const value = String(raw?.value || "").trim().slice(0, type === "regex" ? 180 : 80);
  if (!value) return null;
  if (type === "regex") {
    try {
      compileRegex(value);
    } catch {
      warnings.push(`已忽略无效正则（${packName}）：${value.slice(0, 40)}`);
      return null;
    }
  }
  return { type, target, value };
}

function sanitizePacks(raw, warnings) {
  if (!Array.isArray(raw)) return defaultKeywordPacks();
  const packs = [];
  for (const pack of raw.slice(0, 30)) {
    const name = snippet(pack?.name || "未命名词库", 40) || "未命名词库";
    const patterns = [];
    for (const pattern of (pack?.patterns || []).slice(0, 80)) {
      const clean = sanitizePattern(pattern, warnings, name);
      if (clean) patterns.push(clean);
    }
    const suggest = canonicalTag(pack?.suggestTag) || "";
    packs.push({
      id: String(pack?.id || uid("pack")).slice(0, 40),
      name,
      enabled: pack?.enabled !== false,
      suggestTag: suggest === "Spam" || suggest === "Marketing" ? suggest : "",
      patterns,
    });
  }
  return packs;
}

export function sanitizeSettings(prev, patch) {
  const base = prev ? structuredClone(prev) : defaultSettings();
  const warnings = [];
  const src = patch && typeof patch === "object" ? patch : {};
  if (src.language === "auto" || src.language === "zh" || src.language === "en") base.language = src.language;
  if (src.defaultThreshold != null) base.defaultThreshold = clampInt(src.defaultThreshold, 1, 99, base.defaultThreshold);
  if (src.actionMode === "auto" || src.actionMode === "confirm" || src.actionMode === "prompt-only") base.actionMode = src.actionMode;
  for (const key of ["hideOnThreshold", "muteOnThreshold", "blockOnThreshold", "enablePlatformActions", "rulesEnabled", "hitHistory"]) {
    if (typeof src[key] === "boolean") base[key] = src[key];
  }
  if (src.dailyCap != null) base.dailyCap = clampInt(src.dailyCap, 1, 500, base.dailyCap);
  if (src.rateLimitMs != null) base.rateLimitMs = clampInt(src.rateLimitMs, 1000, 10000, base.rateLimitMs);
  if (src.tagThresholds && typeof src.tagThresholds === "object") {
    const next = { ...base.tagThresholds };
    for (const [name, value] of Object.entries(src.tagThresholds)) {
      const tag = canonicalTag(name);
      if (!tag) continue;
      next[tag] = clampInt(value, 1, 99, base.defaultThreshold);
    }
    base.tagThresholds = next;
  }
  if (Array.isArray(src.customTags)) {
    const tags = [];
    for (const name of src.customTags) {
      const tag = canonicalTag(name);
      if (!tag || BUILTIN_TAGS.includes(tag) || tags.includes(tag)) continue;
      tags.push(tag);
      if (tags.length >= 40) break;
    }
    base.customTags = tags;
    for (const tag of tags) {
      if (!Number.isFinite(Number(base.tagThresholds[tag]))) base.tagThresholds[tag] = base.defaultThreshold;
    }
  }
  if (src.shortcuts && typeof src.shortcuts === "object") {
    const next = { ...base.shortcuts };
    for (const slot of ["spam", "marketing", "picker"]) {
      if (src.shortcuts[slot] == null) continue;
      const parsed = parseShortcutString(src.shortcuts[slot]);
      if (!parsed) {
        warnings.push(`快捷键无效：${slot}`);
        continue;
      }
      next[slot] = formatShortcut(parsed);
    }
    const values = Object.values(next);
    if (new Set(values).size !== values.length) {
      warnings.push("快捷键互相重复，已保留原快捷键。");
    } else {
      base.shortcuts = next;
    }
  }
  if (src.keywordPacks) base.keywordPacks = sanitizePacks(src.keywordPacks, warnings);
  if (src.ai && typeof src.ai === "object") {
    const ai = { ...base.ai };
    if (typeof src.ai.enabled === "boolean") ai.enabled = src.ai.enabled;
    if (typeof src.ai.autoSuggestSuspects === "boolean") ai.autoSuggestSuspects = src.ai.autoSuggestSuspects;
    if (src.ai.endpoint != null) {
      const endpoint = String(src.ai.endpoint || "").trim();
      if (allowedAiEndpoint(endpoint)) ai.endpoint = endpoint;
      else warnings.push("AI 端点需为 https，或本机 http://localhost / 127.0.0.1。");
    }
    if (src.ai.model != null) ai.model = snippet(src.ai.model, 80) || ai.model;
    if (src.ai.apiKey != null) ai.apiKey = String(src.ai.apiKey || "").slice(0, 400);
    ai.hasApiKey = !!ai.apiKey;
    base.ai = ai;
  }
  base.ai.hasApiKey = !!base.ai.apiKey;
  return { settings: base, warnings };
}

function countTag(account, name) {
  return account.tags.find((tag) => tag.name === name)?.count || 0;
}

function ensureAccount(state, input, now) {
  const handle = sanitizeHandle(input.handle);
  const userId = input.userId || (handle ? accountIdFromHandle(handle) : "");
  if (!userId) return null;
  let account = state.ledger[userId];
  if (!account) {
    account = {
      userId,
      handle: handle || "",
      displayName: sanitizeName(input.displayName),
      tags: [],
      whitelist: false,
      followed: input.followed === true ? true : input.followed === false ? false : null,
      updatedAt: now,
    };
    state.ledger[userId] = account;
  }
  if (handle) account.handle = handle;
  if (input.displayName) account.displayName = sanitizeName(input.displayName);
  return account;
}

function upsertEvidence(account, name, evidence) {
  let tag = account.tags.find((item) => item.name === name);
  if (!tag) {
    tag = { name, count: 0, evidence: [] };
    account.tags.push(tag);
  }
  tag.count += 1;
  tag.evidence = [evidence, ...tag.evidence.filter((item) => item.tweetId !== evidence.tweetId)].slice(0, EVIDENCE_CAP);
  return tag;
}

export function statusUrl(handle, tweetId, given) {
  try {
    const url = new URL(given || "");
    if ((url.hostname === "x.com" || url.hostname === "twitter.com") && /\/status\/\d+/.test(url.pathname)) {
      return `https://x.com${url.pathname}`;
    }
  } catch {
    /* build a canonical url below */
  }
  if (handle && /^\d+$/.test(String(tweetId))) return `https://x.com/${handle}/status/${tweetId}`;
  return `https://x.com/${handle || "i"}/status/${tweetId}`;
}

export function rebuildIndex(state) {
  const index = {};
  for (const account of Object.values(state.ledger)) {
    const counts = {};
    for (const tag of account.tags) counts[tag.name] = tag.count;
    index[account.userId] = {
      handle: account.handle,
      displayName: account.displayName || "",
      whitelist: !!account.whitelist,
      followed: account.followed === true ? true : account.followed === false ? false : null,
      hidden: !!state.hidden[account.userId],
      counts,
      updatedAt: account.updatedAt,
    };
  }
  for (const hidden of Object.values(state.hidden)) {
    if (index[hidden.userId]) continue;
    index[hidden.userId] = {
      handle: hidden.handle,
      displayName: "",
      whitelist: false,
      followed: null,
      hidden: true,
      counts: {},
      updatedAt: hidden.hiddenAt,
    };
  }
  state.index = index;
  const tweetTags = {};
  for (const tweet of Object.values(state.tweets)) {
    tweetTags[tweet.tweetId] = { userId: tweet.userId, tags: [...tweet.tags] };
  }
  state.tweetTags = tweetTags;
}

function pushUndo(state, entry) {
  state.undo.unshift(entry);
  state.undo = state.undo.slice(0, UNDO_CAP);
}

function log(state, entry, now) {
  state.log.unshift({ id: uid("log"), at: now, ...entry });
  state.log = state.log.slice(0, LOG_CAP);
}

export function publicAccount(account) {
  return {
    userId: account.userId,
    handle: account.handle,
    displayName: account.displayName || "",
    tags: (account.tags || []).map((tag) => ({
      name: tag.name,
      count: tag.count,
      evidence: (tag.evidence || []).map((item) => ({
        tweetId: item.tweetId,
        url: item.url,
        textSnippet: item.textSnippet,
        markedAt: item.markedAt,
      })),
    })),
    whitelist: !!account.whitelist,
    followed: account.followed === true ? true : account.followed === false ? false : null,
    updatedAt: account.updatedAt,
  };
}

export function toPublicSettings(settings) {
  const copy = structuredClone(settings);
  copy.ai = {
    enabled: !!copy.ai.enabled,
    autoSuggestSuspects: !!copy.ai.autoSuggestSuspects,
    endpoint: copy.ai.endpoint,
    model: copy.ai.model,
    hasApiKey: !!copy.ai.apiKey,
  };
  return copy;
}

function thresholdPayload(state, account, tag, prevCount) {
  const count = countTag(account, tag);
  const n = thresholdFor(state.settings, tag);
  let skipped = null;
  if (account.whitelist) skipped = "whitelist";
  else if (account.followed === true) skipped = "following";
  return {
    reached: count >= n,
    crossed: prevCount < n && count >= n,
    tag,
    count,
    n,
    skipped,
    followed: account.followed,
    mode: state.settings.actionMode,
    suggest: {
      hide: !!state.settings.hideOnThreshold && !account.whitelist && account.followed !== true,
      mute: autoPlatformAllowed(state.settings, account, "mute"),
      block: autoPlatformAllowed(state.settings, account, "block"),
    },
  };
}

export function applyMark(state, input, now) {
  const tag = canonicalTag(input.tag);
  if (!tag) return { ok: false, error: "bad-tag" };
  const handle = sanitizeHandle(input.handle);
  if (!handle) return { ok: false, error: "no-handle" };
  const tweetId = String(input.tweetId || "").trim().slice(0, 40);
  if (!/^[A-Za-z0-9_-]{2,40}$/.test(tweetId)) return { ok: false, error: "no-tweet" };
  const userId = input.userId || accountIdFromHandle(handle);
  const account = ensureAccount(state, { ...input, userId, handle }, now);
  if (input.followed === true || input.followed === false) account.followed = input.followed;
  const prevCount = countTag(account, tag);
  const existing = state.tweets[tweetId];
  if (existing && existing.userId !== userId) return { ok: false, error: "tweet-owner" };
  const tweet = existing || {
    tweetId,
    userId,
    handle,
    url: statusUrl(handle, tweetId, input.url),
    textSnippet: snippet(input.textSnippet),
    tags: [],
    markedAt: now,
    source: input.source || "user",
  };
  if (tweet.tags.includes(tag)) {
    rebuildIndex(state);
    return {
      ok: true,
      already: true,
      userId,
      account: publicAccount(account),
      threshold: null,
    };
  }
  tweet.tags = [...tweet.tags, tag];
  tweet.markedAt = now;
  tweet.handle = handle;
  tweet.url = statusUrl(handle, tweetId, input.url || tweet.url);
  tweet.textSnippet = snippet(input.textSnippet || tweet.textSnippet);
  tweet.source = input.source || tweet.source || "user";
  state.tweets[tweetId] = tweet;
  upsertEvidence(account, tag, {
    tweetId,
    url: tweet.url,
    textSnippet: tweet.textSnippet,
    markedAt: now,
  });
  account.updatedAt = now;
  pushUndo(state, { id: uid("undo"), kind: "mark", tweetId, userId, handle, tag, at: now });
  rebuildIndex(state);
  return {
    ok: true,
    already: false,
    userId,
    account: publicAccount(account),
    threshold: thresholdPayload(state, account, tag, prevCount),
  };
}

export function applyUnmark(state, input, now) {
  const tag = canonicalTag(input.tag);
  const tweet = state.tweets[String(input.tweetId || "")];
  if (!tag || !tweet || !tweet.tags.includes(tag)) return { ok: false, error: "missing" };
  tweet.tags = tweet.tags.filter((item) => item !== tag);
  const account = state.ledger[tweet.userId];
  if (account) {
    const row = account.tags.find((item) => item.name === tag);
    if (row) {
      row.evidence = row.evidence.filter((item) => item.tweetId !== tweet.tweetId);
      row.count = Math.max(0, row.count - 1);
      if (row.count === 0) account.tags = account.tags.filter((item) => item !== row);
    }
    account.updatedAt = now;
  }
  if (!tweet.tags.length) delete state.tweets[tweet.tweetId];
  else state.tweets[tweet.tweetId] = tweet;
  pushUndo(state, { id: uid("undo"), kind: "unmark", tweetId: tweet.tweetId, userId: tweet.userId, handle: tweet.handle, tag, at: now, snapshot: null });
  rebuildIndex(state);
  return { ok: true, userId: tweet.userId, account: account ? publicAccount(account) : null };
}

export function seenAccount(state, input, now) {
  const handle = sanitizeHandle(input.handle);
  const userId = input.userId || (handle ? accountIdFromHandle(handle) : "");
  const account = state.ledger[userId];
  if (!account) return { ok: true, changed: false };
  let changed = false;
  if (handle && account.handle !== handle) {
    account.handle = handle;
    changed = true;
  }
  if (input.displayName && sanitizeName(input.displayName) !== account.displayName) {
    account.displayName = sanitizeName(input.displayName);
    changed = true;
  }
  if ((input.followed === true || input.followed === false) && account.followed !== input.followed) {
    account.followed = input.followed;
    changed = true;
  }
  if (changed) {
    account.updatedAt = now;
    rebuildIndex(state);
  }
  return { ok: true, changed };
}

export function setWhitelist(state, input, now) {
  const handle = sanitizeHandle(input.handle);
  const userId = input.userId || (handle ? accountIdFromHandle(handle) : "");
  if (!userId || !handle && !state.ledger[userId]) return { ok: false, error: "no-handle" };
  const account = ensureAccount(state, { ...input, userId, handle: handle || state.ledger[userId]?.handle }, now);
  const from = !!account.whitelist;
  const to = !!input.whitelist;
  if (from === to) return { ok: true, changed: false, account: publicAccount(account) };
  account.whitelist = to;
  account.updatedAt = now;
  pushUndo(state, { id: uid("undo"), kind: "whitelist", userId, handle: account.handle, from, to, at: now });
  rebuildIndex(state);
  return { ok: true, changed: true, account: publicAccount(account) };
}

export function setHidden(state, input, now) {
  const handle = sanitizeHandle(input.handle) || state.ledger[input.userId]?.handle || state.hidden[input.userId]?.handle || "";
  const userId = input.userId || (handle ? accountIdFromHandle(handle) : "");
  if (!userId || !handle) return { ok: false, error: "no-handle" };
  const from = !!state.hidden[userId];
  const to = !!input.hidden;
  if (from === to) return { ok: true, changed: false, hidden: to };
  if (to) state.hidden[userId] = { userId, handle, hiddenAt: now };
  else delete state.hidden[userId];
  pushUndo(state, { id: uid("undo"), kind: "hidden", userId, handle, from, to, at: now });
  log(state, { type: to ? "hide" : "unhide", userId, handle, ok: true }, now);
  rebuildIndex(state);
  return { ok: true, changed: true, hidden: to };
}

function queueSource(input) {
  if (input?.source === "manual" || input?.source === "undo") return input.source;
  return "auto";
}

export function enqueue(state, input, now) {
  const handle = sanitizeHandle(input.handle) || state.ledger[input.userId]?.handle || "";
  const userId = input.userId || (handle ? accountIdFromHandle(handle) : "");
  const type = input.type;
  if (!userId || !handle || !["mute", "unmute", "block", "unblock"].includes(type)) {
    return { ok: false, error: "bad-action" };
  }
  if (!state.settings.enablePlatformActions) return { ok: false, error: "platform-off" };
  const source = queueSource(input);
  const live = state.queue.find((item) => item.userId === userId && item.type === type && item.status !== "failed");
  if (live) {
    if (source === "manual" || source === "undo") live.source = source;
    return { ok: true, item: live, duplicate: true };
  }
  const failed = state.queue.find((item) => item.userId === userId && item.type === type && item.status === "failed");
  if (failed) {
    failed.status = "pending";
    failed.attempts = 0;
    failed.lastError = "";
    failed.handle = handle;
    failed.inflightAt = 0;
    failed.source = source;
    return { ok: true, item: failed, duplicate: true };
  }
  if (state.queue.length >= QUEUE_MAX) return { ok: false, error: "queue-full" };
  const item = {
    id: uid("q"),
    type,
    userId,
    handle,
    attempts: 0,
    status: "pending",
    source,
    inflightAt: 0,
    lastError: "",
    createdAt: now,
  };
  state.queue.push(item);
  return { ok: true, item, duplicate: false };
}

export function applyActions(state, input, now) {
  const handle = sanitizeHandle(input.handle) || state.ledger[input.userId]?.handle || "";
  const userId = input.userId || (handle ? accountIdFromHandle(handle) : "");
  if (!userId || !handle) return { ok: false, error: "no-handle" };
  const account = state.ledger[userId];
  const reason = input.reason || "manual";
  let hide = !!input.hide;
  let mute = !!input.mute;
  let block = !!input.block;
  const ignored = [];
  if (reason === "threshold-auto") {
    if (state.settings.actionMode !== "auto") return { ok: false, error: "not-auto" };
    if (!account) return { ok: false, error: "no-account" };
    if (account.whitelist) return { ok: false, error: "whitelist" };
    if (account.followed === true) return { ok: false, error: "following" };
    if (!state.settings.hideOnThreshold) hide = false;
    if (!autoPlatformAllowed(state.settings, account, "mute")) {
      if (mute) ignored.push("mute");
      mute = false;
    }
    if (!autoPlatformAllowed(state.settings, account, "block")) {
      if (block) ignored.push("block");
      block = false;
    }
  } else if ((mute || block) && !state.settings.enablePlatformActions) {
    if (mute) ignored.push("mute");
    if (block) ignored.push("block");
    mute = false;
    block = false;
  }
  const done = [];
  if (hide) {
    const hidden = setHidden(state, { userId, handle, hidden: true }, now);
    if (hidden.changed) done.push("hide");
  }
  const source = reason === "threshold-auto" ? "auto" : "manual";
  if (mute) {
    const queued = enqueue(state, { userId, handle, type: "mute", source }, now);
    if (queued.ok) done.push("mute");
    else ignored.push("mute");
  }
  if (block) {
    const queued = enqueue(state, { userId, handle, type: "block", source }, now);
    if (queued.ok) done.push("block");
    else ignored.push("block");
  }
  if (!done.length && ignored.length) return { ok: false, error: "platform-off", ignored };
  rebuildIndex(state);
  return { ok: true, done, ignored, queue: state.queue.filter((item) => item.status === "pending").length };
}

export function expireInflight(state, now) {
  let changed = false;
  for (const item of state.queue) {
    if (item.status === "inflight" && now - (item.inflightAt || 0) > INFLIGHT_MS) {
      item.attempts = (item.attempts || 0) + 1;
      item.status = item.attempts >= QUEUE_ATTEMPTS ? "failed" : "pending";
      item.lastError = item.lastError || "timeout";
      item.inflightAt = 0;
      changed = true;
    }
  }
  return changed;
}

export function peekAction(state, now, options = {}) {
  expireInflight(state, now);
  const pending = state.queue.filter((item) => item.status === "pending");
  if (Array.isArray(options.handles)) {
    const want = new Set(options.handles.map((handle) => String(handle || "").toLowerCase()).filter(Boolean));
    return pending.find((item) => want.has(String(item.handle || "").toLowerCase())) || null;
  }
  return pending[0] || null;
}

/**
 * Why the processor must not start a click right now.
 * Empty queues do not report a hold, so the options page is not nagged.
 */
export function processorHold(state, now) {
  const changed = expireInflight(state, now);
  const hasPending = state.queue.some((item) => item.status === "pending");
  if (!hasPending) return { hold: null, changed };
  if (!state.settings.enablePlatformActions) return { hold: "platform-off", changed };
  if (state.rate?.paused) return { hold: "paused", changed };
  const backoffUntil = state.rate?.backoffUntil || 0;
  if (now < backoffUntil) return { hold: "backoff", wait: backoffUntil - now, changed };
  const day = localDay(now);
  const count = state.rate?.day === day ? state.rate.count || 0 : 0;
  if (count >= state.settings.dailyCap) return { hold: "daily-cap", changed };
  const nextAllowed = state.rate?.nextAllowed || 0;
  if (now < nextAllowed) return { hold: "rate", wait: nextAllowed - now, changed };
  return { hold: null, changed };
}

export function beginAction(state, id, now) {
  const expired = expireInflight(state, now);
  const item = state.queue.find((entry) => entry.id === id);
  if (!item || item.status === "failed") return { ok: false, error: "missing", expired };
  if (item.status === "inflight" && now - (item.inflightAt || 0) < INFLIGHT_MS) return { ok: false, error: "inflight", expired };
  if (!state.settings.enablePlatformActions) return { ok: false, error: "platform-off", expired };
  if (item.source !== "manual" && item.source !== "undo") {
    const account = state.ledger[item.userId];
    if (account?.whitelist || account?.followed === true) {
      state.queue = state.queue.filter((entry) => entry.id !== item.id);
      return { ok: false, error: account?.whitelist ? "whitelist" : "following", changed: true, expired };
    }
  }
  if (state.rate?.paused) return { ok: false, error: "paused", expired };
  const backoffUntil = state.rate?.backoffUntil || 0;
  if (now < backoffUntil) return { ok: false, error: "backoff", wait: backoffUntil - now, expired };
  const today = localDay(now);
  const count = state.rate?.day === today ? state.rate.count || 0 : 0;
  if (count >= state.settings.dailyCap) return { ok: false, error: "daily-cap", expired };
  if (now < (state.rate?.nextAllowed || 0)) {
    return { ok: false, error: "rate", wait: state.rate.nextAllowed - now, expired };
  }
  state.rate.day = today;
  state.rate.count = count + 1;
  state.rate.nextAllowed = now + nextActionDelayMs(state.settings.rateLimitMs);
  item.status = "inflight";
  item.inflightAt = now;
  return { ok: true, item: { ...item } };
}

export function finishAction(state, input, now) {
  const index = state.queue.findIndex((item) => item.id === input.id);
  if (index < 0) return { ok: false, error: "missing" };
  const item = state.queue[index];
  if (input.ok) {
    state.queue.splice(index, 1);
    state.rate.rateStrikes = 0;
    state.rate.backoffUntil = 0;
    state.rate.lastError = "";
    log(state, { type: item.type, userId: item.userId, handle: item.handle, ok: true }, now);
    pushUndo(state, {
      id: uid("undo"),
      kind: "platform",
      action: item.type,
      userId: item.userId,
      handle: item.handle,
      at: now,
    });
    return { ok: true, item };
  }
  const rateLimited = input.rateLimited === true || isRateLimitSignal(input.error);
  item.attempts = (item.attempts || 0) + 1;
  item.status = item.attempts >= QUEUE_ATTEMPTS ? "failed" : "pending";
  item.lastError = snippet(input.error || (rateLimited ? "rate-limit" : "fail"), 160);
  item.inflightAt = 0;
  if (rateLimited) {
    state.rate.rateStrikes = clampInt((state.rate.rateStrikes || 0) + 1, 1, 20, 1);
    state.rate.backoffUntil = now + backoffDelayMs(state.rate.rateStrikes);
  }
  state.rate.lastError = item.lastError;
  log(state, { type: item.type, userId: item.userId, handle: item.handle, ok: false, error: item.lastError }, now);
  return { ok: true, item, rateLimited, backoffUntil: state.rate.backoffUntil || 0 };
}

export function setQueuePaused(state, paused, now) {
  state.rate.paused = !!paused;
  log(state, { type: paused ? "pause" : "resume", ok: true }, now);
  return { ok: true, paused: state.rate.paused };
}

export function clearQueue(state, scope = "pending") {
  const before = state.queue.length;
  if (scope === "all") state.queue = [];
  else if (scope === "failed") state.queue = state.queue.filter((item) => item.status !== "failed");
  else state.queue = state.queue.filter((item) => item.status === "failed");
  return { ok: true, removed: before - state.queue.length, queue: state.queue.length };
}

export function retryFailed(state) {
  let retried = 0;
  for (const item of state.queue) {
    if (item.status !== "failed") continue;
    item.status = "pending";
    item.attempts = 0;
    item.lastError = "";
    item.inflightAt = 0;
    retried += 1;
  }
  if (retried) state.rate.lastError = "";
  return { ok: true, retried };
}

export function retryAction(state, id) {
  const item = state.queue.find((entry) => entry.id === id);
  if (!item) return { ok: false, error: "missing" };
  item.status = "pending";
  item.attempts = 0;
  item.lastError = "";
  item.inflightAt = 0;
  if (!state.queue.some((entry) => entry.lastError)) state.rate.lastError = "";
  return { ok: true, item };
}

export function cancelAction(state, id) {
  const before = state.queue.length;
  state.queue = state.queue.filter((item) => item.id !== id);
  return { ok: state.queue.length !== before };
}

export function applyUndo(state, now) {
  const entry = state.undo.shift();
  if (!entry) return { ok: false, error: "empty" };
  if (entry.kind === "mark") {
    const tweet = state.tweets[entry.tweetId];
    if (tweet) {
      tweet.tags = tweet.tags.filter((tag) => tag !== entry.tag);
      if (!tweet.tags.length) delete state.tweets[entry.tweetId];
    }
    const account = state.ledger[entry.userId];
    if (account) {
      const row = account.tags.find((tag) => tag.name === entry.tag);
      if (row) {
        row.evidence = row.evidence.filter((item) => item.tweetId !== entry.tweetId);
        row.count = Math.max(0, row.count - 1);
        if (row.count === 0) account.tags = account.tags.filter((tag) => tag !== row);
      }
      account.updatedAt = now;
    }
  } else if (entry.kind === "unmark") {
    applyMark(state, {
      userId: entry.userId,
      handle: entry.handle,
      tweetId: entry.tweetId,
      tag: entry.tag,
      textSnippet: "",
      source: "undo",
    }, now);
    state.undo.shift();
  } else if (entry.kind === "hidden") {
    if (entry.from) state.hidden[entry.userId] = { userId: entry.userId, handle: entry.handle, hiddenAt: now };
    else delete state.hidden[entry.userId];
  } else if (entry.kind === "whitelist") {
    const account = state.ledger[entry.userId];
    if (account) {
      account.whitelist = !!entry.from;
      account.updatedAt = now;
    }
  } else if (entry.kind === "platform") {
    const reverse = oppositeAction(entry.action);
    const queued = enqueue(state, { userId: entry.userId, handle: entry.handle, type: reverse, source: "undo" }, now);
    if (!queued.ok) {
      state.undo.unshift(entry);
      return { ok: false, error: queued.error || "undo-failed" };
    }
  } else if (entry.kind === "delete-account") {
    state.ledger[entry.userId] = entry.account;
    if (entry.hidden) state.hidden[entry.userId] = entry.hidden;
    Object.assign(state.tweets, entry.tweets || {});
  } else if (entry.kind === "clear-tag") {
    const account = state.ledger[entry.userId];
    if (account && entry.tagRow) {
      account.tags.push(entry.tagRow);
      for (const snap of entry.snapshots || []) state.tweets[snap.tweetId] = snap;
    }
  }
  log(state, { type: "undo", kind: entry.kind, userId: entry.userId, handle: entry.handle || entry.account?.handle, ok: true }, now);
  rebuildIndex(state);
  return { ok: true, entry: describeUndo(entry) };
}

export function describeUndo(entry) {
  if (!entry) return null;
  return {
    kind: entry.kind,
    tag: entry.tag || "",
    handle: entry.handle || entry.account?.handle || "",
    userId: entry.userId || "",
    action: entry.action || "",
  };
}

export function deleteAccount(state, userId, now) {
  const account = state.ledger[userId];
  if (!account) return { ok: false, error: "missing" };
  const tweets = {};
  for (const [id, tweet] of Object.entries(state.tweets)) {
    if (tweet.userId === userId) {
      tweets[id] = tweet;
      delete state.tweets[id];
    }
  }
  const hidden = state.hidden[userId] || null;
  delete state.ledger[userId];
  delete state.hidden[userId];
  state.queue = state.queue.filter((item) => item.userId !== userId);
  pushUndo(state, { id: uid("undo"), kind: "delete-account", userId, handle: account.handle, account, tweets, hidden, at: now });
  log(state, { type: "delete-account", userId, handle: account.handle, ok: true }, now);
  rebuildIndex(state);
  return { ok: true };
}

export function clearTag(state, input, now) {
  const tag = canonicalTag(input.tag);
  const account = state.ledger[input.userId];
  if (!account || !tag) return { ok: false, error: "missing" };
  const row = account.tags.find((item) => item.name === tag);
  if (!row) return { ok: false, error: "missing" };
  const snapshots = [];
  for (const tweet of Object.values(state.tweets)) {
    if (tweet.userId === account.userId && tweet.tags.includes(tag)) snapshots.push(structuredClone(tweet));
  }
  for (const snap of snapshots) {
    const tweet = state.tweets[snap.tweetId];
    tweet.tags = tweet.tags.filter((item) => item !== tag);
    if (!tweet.tags.length) delete state.tweets[tweet.tweetId];
  }
  account.tags = account.tags.filter((item) => item !== row);
  account.updatedAt = now;
  pushUndo(state, { id: uid("undo"), kind: "clear-tag", userId: account.userId, handle: account.handle, tag, tagRow: row, snapshots, at: now });
  rebuildIndex(state);
  return { ok: true };
}

export function addCustomTag(state, name) {
  const tag = canonicalTag(name);
  if (!tag) return { ok: false, error: "bad-tag" };
  if (BUILTIN_TAGS.includes(tag)) return { ok: true, tag, existed: true };
  if (!state.settings.customTags.includes(tag)) {
    if (state.settings.customTags.length >= 40) return { ok: false, error: "too-many-tags" };
    state.settings.customTags.push(tag);
    state.settings.tagThresholds[tag] = state.settings.defaultThreshold;
  }
  return { ok: true, tag, existed: false };
}

export function removeCustomTag(state, name) {
  const tag = canonicalTag(name);
  if (!tag || BUILTIN_TAGS.includes(tag)) return { ok: false, error: "builtin" };
  state.settings.customTags = state.settings.customTags.filter((item) => item !== tag);
  return { ok: true, tag };
}

export function searchLedger(state, query, limit = 40) {
  const q = fold(query || "");
  const rows = Object.values(state.ledger).map((account) => ({
    ...publicAccount(account),
    hidden: !!state.hidden[account.userId],
  }));
  for (const hidden of Object.values(state.hidden)) {
    if (state.ledger[hidden.userId]) continue;
    rows.push({
      userId: hidden.userId,
      handle: hidden.handle,
      displayName: "",
      tags: [],
      whitelist: false,
      followed: null,
      updatedAt: hidden.hiddenAt,
      hidden: true,
    });
  }
  const filtered = q
    ? rows.filter((account) => fold([account.handle, account.displayName, ...account.tags.map((tag) => tag.name)].join(" ")).includes(q))
    : rows;
  filtered.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return filtered.slice(0, limit);
}

export function queueDashboard(state, now = Date.now()) {
  const day = localDay(now);
  const pending = state.queue.filter((item) => item.status === "pending");
  const inflight = state.queue.filter((item) => item.status === "inflight");
  const failed = state.queue.filter((item) => item.status === "failed");
  const lastFromItems = [...state.queue].reverse().find((item) => item.lastError)?.lastError || "";
  return {
    length: pending.length + inflight.length,
    pending: pending.length,
    inflight: inflight.length,
    failed: failed.length,
    failedItems: failed.map((item) => ({
      id: item.id,
      type: item.type,
      handle: item.handle,
      lastError: item.lastError || "",
      attempts: item.attempts || 0,
    })),
    lastError: state.rate?.lastError || lastFromItems || "",
    actionsToday: state.rate?.day === day ? state.rate.count || 0 : 0,
    dailyCap: state.settings.dailyCap,
    paused: !!state.rate?.paused,
    backoffUntil: state.rate?.backoffUntil || 0,
    nextAllowed: state.rate?.nextAllowed || 0,
    rateStrikes: state.rate?.rateStrikes || 0,
  };
}

export function statsOf(state, now = Date.now()) {
  const dash = queueDashboard(state, now);
  const byTag = {};
  let strikes = 0;
  for (const account of Object.values(state.ledger)) {
    for (const tag of account.tags) {
      byTag[tag.name] = (byTag[tag.name] || 0) + tag.count;
      strikes += tag.count;
    }
  }
  return {
    accounts: Object.keys(state.ledger).length,
    strikes,
    hidden: Object.keys(state.hidden).length,
    tweets: Object.keys(state.tweets).length,
    byTag,
    queue: dash.length,
    failed: dash.failed,
    actionsToday: dash.actionsToday,
    dailyCap: dash.dailyCap,
    paused: dash.paused,
    lastError: dash.lastError,
    backoffUntil: dash.backoffUntil,
    mode: state.settings.actionMode,
    rulesEnabled: !!state.settings.rulesEnabled,
    aiEnabled: !!state.settings.ai.enabled,
  };
}

function normalizeEvidence(raw, fallbackTime) {
  const tweetId = String(raw?.tweetId || "").trim().slice(0, 40);
  if (!/^[A-Za-z0-9_-]{2,40}$/.test(tweetId)) return null;
  return {
    tweetId,
    url: statusUrl("", tweetId, raw.url),
    textSnippet: snippet(raw.textSnippet),
    markedAt: timeOf(raw.markedAt, fallbackTime),
  };
}

function normalizeAccount(raw, now) {
  if (!raw || typeof raw !== "object") return null;
  const fromId = String(raw.userId || "").startsWith("h:") ? String(raw.userId).slice(2) : "";
  const handle = sanitizeHandle(raw.handle) || sanitizeHandle(fromId);
  const userId = String(raw.userId || (handle ? accountIdFromHandle(handle) : "")).slice(0, 80);
  if (!userId || !/^[\w:.-]+$/.test(userId)) return null;
  const tags = [];
  const rawTags = Array.isArray(raw.tags) ? raw.tags : Object.values(raw.tags || {});
  for (const tag of rawTags) {
    const name = canonicalTag(tag?.name);
    if (!name) continue;
    const evidence = [];
    for (const item of (tag.evidence || []).slice(0, EVIDENCE_CAP)) {
      const clean = normalizeEvidence(item, now);
      if (clean && !evidence.some((row) => row.tweetId === clean.tweetId)) evidence.push(clean);
    }
    const count = Math.max(clampInt(tag.count, 0, 100000, 0), evidence.length);
    if (!count) continue;
    tags.push({ name, count, evidence });
  }
  return {
    userId,
    handle: handle || "",
    displayName: sanitizeName(raw.displayName),
    tags,
    whitelist: !!raw.whitelist,
    followed: raw.followed === true ? true : raw.followed === false ? false : null,
    updatedAt: timeOf(raw.updatedAt, now),
  };
}

function mergeTagRows(a, b) {
  const map = new Map();
  for (const item of [...(a?.evidence || []), ...(b?.evidence || [])]) map.set(item.tweetId, item);
  const evidence = [...map.values()].sort((x, y) => y.markedAt - x.markedAt).slice(0, EVIDENCE_CAP);
  return {
    name: a?.name || b?.name,
    count: Math.max(a?.count || 0, b?.count || 0, map.size),
    evidence,
  };
}

export function exportData(state, options = {}) {
  const settings = structuredClone(state.settings);
  if (!options.includeSecrets) settings.ai.apiKey = "";
  settings.ai.hasApiKey = !!state.settings.ai.apiKey;
  const stamp = (ms) => new Date(ms || Date.now()).toISOString();
  return {
    schema: SCHEMA,
    product: PRODUCT,
    exportedAt: new Date().toISOString(),
    settings,
    ledger: Object.fromEntries(Object.values(state.ledger).map((account) => {
      const pub = publicAccount(account);
      pub.updatedAt = stamp(account.updatedAt);
      pub.tags = pub.tags.map((tag) => ({
        ...tag,
        evidence: tag.evidence.map((item) => ({ ...item, markedAt: stamp(item.markedAt) })),
      }));
      return [account.userId, pub];
    })),
    tweets: Object.values(state.tweets).map((tweet) => ({ ...tweet, markedAt: stamp(tweet.markedAt) })),
    hidden: Object.values(state.hidden).map((item) => ({ ...item, hiddenAt: stamp(item.hiddenAt) })),
  };
}

export function importData(state, payload, options, now) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, error: "bad-file" };
  const mode = options?.mode === "replace" ? "replace" : "merge";
  const incomingLedger = payload.ledger || payload.accounts || {};
  const accounts = Array.isArray(incomingLedger) ? incomingLedger : Object.values(incomingLedger);
  if (accounts.length > 20000 || (payload.tweets && Object.keys(payload.tweets).length > 50000)) {
    return { ok: false, error: "too-large" };
  }
  if (mode === "replace") {
    state.ledger = {};
    state.tweets = {};
    state.hidden = {};
    state.queue = [];
  }
  let merged = 0;
  for (const raw of accounts) {
    const account = normalizeAccount(raw, now);
    if (!account) continue;
    const local = state.ledger[account.userId];
    if (!local || mode === "replace") {
      state.ledger[account.userId] = account;
    } else {
      local.displayName = account.displayName || local.displayName;
      local.handle = account.handle || local.handle;
      local.whitelist = local.whitelist || account.whitelist;
      if (account.followed === true) local.followed = true;
      else if (local.followed == null) local.followed = account.followed;
      const names = new Set([...local.tags.map((tag) => tag.name), ...account.tags.map((tag) => tag.name)]);
      local.tags = [...names].map((name) => mergeTagRows(local.tags.find((tag) => tag.name === name), account.tags.find((tag) => tag.name === name)));
      local.updatedAt = Math.max(local.updatedAt || 0, account.updatedAt || 0);
    }
    const stored = state.ledger[account.userId];
    for (const tag of stored.tags) {
      for (const evidence of tag.evidence) {
        const existing = state.tweets[evidence.tweetId];
        if (!existing) {
          state.tweets[evidence.tweetId] = {
            tweetId: evidence.tweetId,
            userId: stored.userId,
            handle: stored.handle,
            url: evidence.url,
            textSnippet: evidence.textSnippet,
            tags: [tag.name],
            markedAt: evidence.markedAt,
            source: "import",
          };
        } else if (existing.userId === stored.userId && !existing.tags.includes(tag.name)) {
          existing.tags.push(tag.name);
        }
      }
    }
    merged += 1;
  }
  const tweets = Array.isArray(payload.tweets) ? payload.tweets : Object.values(payload.tweets || {});
  for (const raw of tweets) {
    const tweetId = String(raw?.tweetId || "").trim();
    const handle = sanitizeHandle(raw?.handle);
    const userId = String(raw?.userId || (handle ? accountIdFromHandle(handle) : ""));
    if (!/^[A-Za-z0-9_-]{2,40}$/.test(tweetId) || !userId) continue;
    const tags = [...new Set((raw.tags || []).map(canonicalTag).filter(Boolean))];
    const existing = state.tweets[tweetId];
    if (!existing) {
      state.tweets[tweetId] = {
        tweetId,
        userId,
        handle: handle || state.ledger[userId]?.handle || "",
        url: statusUrl(handle, tweetId, raw.url),
        textSnippet: snippet(raw.textSnippet),
        tags,
        markedAt: timeOf(raw.markedAt, now),
        source: raw.source || "import",
      };
    } else if (existing.userId === userId) {
      for (const tag of tags) if (!existing.tags.includes(tag)) existing.tags.push(tag);
    }
  }
  const hiddenList = Array.isArray(payload.hidden) ? payload.hidden : Object.values(payload.hidden || {});
  for (const raw of hiddenList) {
    const handle = sanitizeHandle(raw?.handle);
    const userId = String(raw?.userId || (handle ? accountIdFromHandle(handle) : ""));
    if (!userId || !handle) continue;
    if (!state.hidden[userId]) state.hidden[userId] = { userId, handle, hiddenAt: timeOf(raw.hiddenAt, now) };
  }
  let warnings = [];
  if (options?.settings && payload.settings) {
    const patch = structuredClone(payload.settings);
    if (!options.includeSecrets && patch.ai) delete patch.ai.apiKey;
    const sanitized = sanitizeSettings(state.settings, patch);
    state.settings = sanitized.settings;
    warnings = sanitized.warnings;
  }
  log(state, { type: "import", ok: true, detail: `${mode}:${merged}` }, now);
  rebuildIndex(state);
  return { ok: true, mode, accounts: merged, warnings };
}

export function normalizeState(raw, now = Date.now()) {
  const state = freshState(now);
  if (!raw || typeof raw !== "object") {
    rebuildIndex(state);
    return state;
  }
  const sanitized = sanitizeSettings(state.settings, raw.settings || {});
  state.settings = sanitized.settings;
  if (raw.settings?.ai && Object.prototype.hasOwnProperty.call(raw.settings.ai, "apiKey")) {
    state.settings.ai.apiKey = String(raw.settings.ai.apiKey || "").slice(0, 400);
    state.settings.ai.hasApiKey = !!state.settings.ai.apiKey;
  }
  state.ledger = {};
  for (const account of Object.values(raw.ledger || {})) {
    const clean = normalizeAccount(account, now);
    if (clean) state.ledger[clean.userId] = clean;
  }
  state.tweets = {};
  for (const tweet of Object.values(raw.tweets || {})) {
    const tweetId = String(tweet?.tweetId || "");
    const handle = sanitizeHandle(tweet?.handle);
    const userId = String(tweet?.userId || "");
    if (!tweetId || !userId) continue;
    state.tweets[tweetId] = {
      tweetId,
      userId,
      handle: handle || "",
      url: statusUrl(handle, tweetId, tweet.url),
      textSnippet: snippet(tweet.textSnippet),
      tags: [...new Set((tweet.tags || []).map(canonicalTag).filter(Boolean))],
      markedAt: timeOf(tweet.markedAt, now),
      source: snippet(tweet.source || "user", 24),
    };
  }
  state.hidden = {};
  for (const item of Object.values(raw.hidden || {})) {
    const handle = sanitizeHandle(item?.handle);
    const userId = String(item?.userId || "");
    if (!userId || !handle) continue;
    state.hidden[userId] = { userId, handle, hiddenAt: timeOf(item.hiddenAt, now) };
  }
  state.queue = Array.isArray(raw.queue) ? raw.queue.slice(0, QUEUE_MAX).map((item) => ({
    id: String(item.id || uid("q")),
    type: ["mute", "unmute", "block", "unblock"].includes(item.type) ? item.type : "mute",
    userId: String(item.userId || ""),
    handle: sanitizeHandle(item.handle),
    attempts: clampInt(item.attempts, 0, 20, 0),
    status: ["pending", "inflight", "failed"].includes(item.status) ? item.status : "pending",
    source: item.source === "manual" || item.source === "undo" ? item.source : "auto",
    inflightAt: timeOf(item.inflightAt, 0),
    lastError: snippet(item.lastError, 160),
    createdAt: timeOf(item.createdAt, now),
  })).filter((item) => item.userId && item.handle) : [];
  state.log = Array.isArray(raw.log) ? raw.log.slice(0, LOG_CAP) : [];
  state.undo = Array.isArray(raw.undo) ? raw.undo.slice(0, UNDO_CAP) : [];
  state.aiCache = raw.aiCache && typeof raw.aiCache === "object" ? raw.aiCache : {};
  state.hitLog = [];
  if (Array.isArray(raw.hitLog)) {
    for (const item of raw.hitLog.slice(0, HIT_LOG_CAP)) {
      const pattern = snippet(item?.pattern, 80);
      const packId = String(item?.packId || "").slice(0, 40);
      const tweetId = String(item?.tweetId || "").replace(/[^\w-]/g, "").slice(0, 40);
      if (!pattern || !packId || !tweetId) continue;
      state.hitLog.push({
        at: timeOf(item.at, now),
        packId,
        packName: snippet(item.packName, 40),
        pattern,
        target: ["text", "handle", "bio", "any"].includes(item.target) ? item.target : "text",
        handle: sanitizeHandle(item.handle),
        tweetId,
        snippet: snippet(item.snippet, 80),
      });
    }
  }
  state.rate = {
    day: typeof raw.rate?.day === "string" ? raw.rate.day : localDay(now),
    count: clampInt(raw.rate?.count, 0, 10000, 0),
    nextAllowed: timeOf(raw.rate?.nextAllowed, 0),
    paused: raw.rate?.paused === true,
    backoffUntil: timeOf(raw.rate?.backoffUntil, 0),
    lastError: snippet(raw.rate?.lastError, 160),
    rateStrikes: clampInt(raw.rate?.rateStrikes, 0, 20, 0),
  };
  rebuildIndex(state);
  return state;
}

export function restorePacks(state) {
  state.settings.keywordPacks = defaultKeywordPacks();
  return state.settings.keywordPacks;
}

export function pruneAiCache(cache) {
  const entries = Object.entries(cache || {});
  if (entries.length <= AI_CACHE_CAP) return cache || {};
  entries.sort((a, b) => (a[1]?.at || 0) - (b[1]?.at || 0));
  return Object.fromEntries(entries.slice(entries.length - AI_CACHE_CAP));
}
