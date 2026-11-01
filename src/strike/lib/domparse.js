/**
 * Read author, status id, text, and follow state from an X article.
 * Selectors follow public data-testid hooks (article, User-Name, tweetText,
 * caret, follow/unfollow). Quote posts are ignored so the outer author wins.
 *
 * On a tweet detail page the focal post and each reply are the same kind of
 * node: `article[data-testid="tweet"]` (also `article[role="article"]`).
 * The focal card is the one whose /status/ id equals the URL. Other tweet
 * articles on that page are replies. This file does not call GraphQL.
 */

/** Tweet cards on the home timeline and on a status thread. */
export const TWEET_ARTICLE_SELECTOR = 'article[data-testid="tweet"], article[role="article"]';

/**
 * Status id of the open tweet, or "" when this path is not a detail thread.
 * `/user/status/123`, `/i/status/123`, `/i/web/status/123`, and the photo/video
 * viewer count. Quotes, likes, retweets, and analytics do not.
 * @param {string} pathname
 * @returns {string}
 */
export function focalStatusId(pathname) {
  const path = String(pathname || "").split("?")[0].split("#")[0].replace(/\/+$/, "") || "/";
  const web = path.match(/^\/i\/web\/status(?:es)?\/(\d+)(?:\/(?:photo|video)\/\d+)?$/);
  if (web) return web[1];
  const match = path.match(/^\/(?:[A-Za-z0-9_]{1,15}|i)\/status(?:es)?\/(\d+)(?:\/(?:photo|video)\/\d+)?$/);
  return match ? match[1] : "";
}

/**
 * "timeline" off a detail thread, "focal" for the status in the URL (or a card
 * whose id we could not read — do not comment-fold that), "reply" otherwise.
 * @param {string} pathname
 * @param {string} [tweetId]
 * @returns {"timeline" | "focal" | "reply"}
 */
export function articleSurface(pathname, tweetId) {
  const focal = focalStatusId(pathname);
  if (!focal) return "timeline";
  if (!tweetId || !/^\d+$/.test(String(tweetId))) return "focal";
  return String(tweetId) === focal ? "focal" : "reply";
}

/**
 * Quote embeds and cards nested inside another tweet article are not their
 * own reply. `closest` includes the node itself, so the walk starts at the parent.
 * @param {{ closest?: (selector: string) => unknown, parentElement?: { closest?: (selector: string) => unknown } | null } | null | undefined} article
 */
export function isNestedTweetArticle(article) {
  if (!article || typeof article.closest !== "function") return false;
  const parent = article.parentElement;
  if (!parent || typeof parent.closest !== "function") return false;
  if (parent.closest('[data-testid="quoteTweet"]')) return true;
  return !!parent.closest(TWEET_ARTICLE_SELECTOR);
}

const RESERVED = new Set([
  "home", "explore", "search", "notifications", "messages", "settings", "i",
  "compose", "intent", "share", "hashtag", "tos", "privacy", "login", "signup",
  "jobs", "about", "explore",
]);

export function isReservedHandle(handle) {
  return RESERVED.has(String(handle || "").toLowerCase());
}

function cleanHandle(value) {
  const s = String(value || "").trim().replace(/^@+/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(s)) return "";
  if (isReservedHandle(s)) return "";
  return s;
}

function visibleText(node) {
  if (!node) return "";
  return String(node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
}

export function parseArticle(article, ctx = {}) {
  if (!article || typeof article.querySelectorAll !== "function") return null;
  const quote = article.querySelector('[data-testid="quoteTweet"]');
  const outsideQuote = (node) => !quote || !quote.contains(node);

  let nameBlock = [...article.querySelectorAll('[data-testid="User-Name"]')].find(outsideQuote);
  if (!nameBlock) nameBlock = article.querySelector('[data-testid="User-Name"]');

  let handle = "";
  const avatars = [...article.querySelectorAll('[data-testid^="UserAvatar-Container-"]')].filter(outsideQuote);
  for (const avatar of avatars) {
    const testid = avatar.getAttribute("data-testid") || "";
    const parsed = cleanHandle(testid.slice("UserAvatar-Container-".length));
    if (parsed) {
      handle = parsed;
      break;
    }
  }

  const links = nameBlock ? [...nameBlock.querySelectorAll("a[href]")] : [];
  let displayName = "";
  for (const link of links) {
    const href = link.getAttribute("href") || "";
    const match = href.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
    if (!match) continue;
    const candidate = cleanHandle(match[1]);
    if (!candidate) continue;
    const text = visibleText(link);
    if (text.startsWith("@")) {
      handle = handle || candidate;
      continue;
    }
    if (!handle) handle = candidate;
    if (!displayName && text && !text.startsWith("@")) displayName = text.slice(0, 80);
  }
  if (!handle) {
    const at = visibleText(nameBlock).match(/@([A-Za-z0-9_]{1,15})/);
    if (at) handle = cleanHandle(at[1]);
  }
  if (!handle) return null;

  let tweetId = "";
  let url = "";
  const times = [...article.querySelectorAll("time")].filter(outsideQuote);
  for (const time of times) {
    const anchor = time.closest?.('a[href*="/status/"]');
    const href = anchor?.getAttribute("href") || "";
    const match = href.match(/\/status\/(\d+)/);
    if (!match) continue;
    tweetId = match[1];
    url = `https://x.com/${handle}/status/${tweetId}`;
    break;
  }
  if (!tweetId) {
    const anchors = [...article.querySelectorAll('a[href*="/status/"]')].filter(outsideQuote);
    for (const anchor of anchors) {
      const href = anchor.getAttribute("href") || "";
      if (!href.includes(`/${handle}/`) && !href.startsWith(`/${handle}?`)) {
        const loose = href.match(/\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/);
        if (loose && loose[1].toLowerCase() !== handle.toLowerCase()) continue;
      }
      const match = href.match(/\/status\/(\d+)/);
      if (!match) continue;
      tweetId = match[1];
      url = `https://x.com/${handle}/status/${tweetId}`;
      break;
    }
  }

  const text = [...article.querySelectorAll('[data-testid="tweetText"]')]
    .filter(outsideQuote)
    .map(visibleText)
    .filter(Boolean)
    .join("\n");

  let bio = [...article.querySelectorAll('[data-testid="UserDescription"]')]
    .filter(outsideQuote)
    .map(visibleText)
    .find(Boolean) || "";
  const pathHandle = String(ctx.pathname || "").split("/").filter(Boolean)[0] || "";
  if (!bio && pathHandle.toLowerCase() === handle.toLowerCase()) bio = String(ctx.profileBio || "");

  const followed = detectFollowed(article, outsideQuote, ctx, handle);
  return {
    handle,
    displayName,
    tweetId,
    url,
    text,
    bio,
    followed,
    userId: `h:${handle.toLowerCase()}`,
  };
}

function detectFollowed(article, outsideQuote, ctx, handle) {
  const buttons = [...article.querySelectorAll("button, [role='button']")].filter(outsideQuote);
  for (const button of buttons) {
    const testid = button.getAttribute("data-testid") || "";
    if (testid === "unfollow" || testid.endsWith("-unfollow")) return true;
  }
  for (const button of buttons) {
    const testid = button.getAttribute("data-testid") || "";
    if (testid === "follow" || (testid.endsWith("-follow") && !testid.endsWith("-unfollow"))) return false;
  }
  for (const button of buttons) {
    const label = `${button.getAttribute("aria-label") || ""} ${visibleText(button)}`;
    if (/unfollow|following @|正在关注|已关注/i.test(label) && !/followers|关注者/i.test(label)) return true;
    if (/(^|\s)follow @|关注 @/i.test(label)) return false;
  }
  const pathHandle = String(ctx.pathname || "").split("/").filter(Boolean)[0] || "";
  if (pathHandle.toLowerCase() === handle.toLowerCase() && (ctx.profileFollowed === true || ctx.profileFollowed === false)) {
    return ctx.profileFollowed;
  }
  return null;
}

export function findMenuItem(doc, kind, handle, testIds, labelMatches) {
  const menus = [...doc.querySelectorAll('[role="menu"], [data-testid="Dropdown"]')];
  const scope = menus.length ? menus[menus.length - 1] : doc;
  for (const id of testIds || []) {
    const node = scope.querySelector(`[data-testid="${id}"]`);
    if (!node) continue;
    return node.closest?.('[role="menuitem"]') || node;
  }
  const items = [...scope.querySelectorAll('[role="menuitem"]')];
  return items.find((item) => labelMatches(item.innerText || item.textContent || "", kind, handle)) || null;
}
