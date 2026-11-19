/**
 * For You 自动筛选 — 类型与默认值（M1：规则版）。
 * 唯一事实来源：设计文档 ~/workspace/x-bookmark-keeper-foryou/DESIGN.md。
 * 本文件是 `xsl.settings.foryou` 默认值的唯一来源：
 * `src/strike/lib/pure.js` 的 defaultSettings() 引用 defaultForYouSettings()，
 * 两边不要各写一份默认值。
 */

export type ForYouMode = "rule" | "vector" | "hybrid";

export interface ForYouTopic {
  id: string;
  label: string;
  /** 0.1–2，默认 1.0；话题分 = weight × hitStrength（设计 §3.2） */
  weight: number;
  keywords: string[];
  /** 由标签自动生成的话题（M3 画像构建时产生；M1 只有用户手填的） */
  auto?: boolean;
}

export interface ForYouDestination {
  kind: "bookmark" | "folder";
  /** kind 为 folder 时的目标文件夹名（本地文件夹；M2 执行时不存在则自动创建） */
  folder: string;
}

export interface ForYouEmbedConfig {
  endpoint: string;
  model: string;
}

export interface ForYouSettings {
  enabled: boolean;
  mode: ForYouMode;
  bookmarkThreshold: number;
  hideThreshold: number;
  showScoreChip: boolean;
  autoScroll: boolean;
  dailyCap: number;
  minGapMs: number;
  destination: ForYouDestination;
  topics: ForYouTopic[];
  languages: string[];
  profileHalfLifeDays: number;
  vetoCooldownDays: number;
  embed: ForYouEmbedConfig;
  /** M4 反馈写入；M1 只保留字段，不产生 veto */
  authorVetoes: { handle: string; until: number }[];
  keywordVetoes: { keyword: string; until: number }[];
}

export interface ForYouScoreInput {
  tweetId: string;
  handle: string;
  text: string;
  quotedText?: string;
  followed: boolean | null;
  likes?: number | null;
  reposts?: number | null;
  views?: number | null;
  lang?: string;
}

export interface ForYouScoreContext {
  topics: ForYouTopic[];
  /** M3 画像构建时算出的常收藏作者（书签数 ≥ 10，Top 50）；M1 为空 */
  topAuthors?: ReadonlySet<string> | null;
  /** M3 画像构建时算出的库互动中位数；M1 为空 → 互动分取中性 0.5 */
  medianLikes?: number | null;
  /** 作者在 Strike 白名单 */
  whitelist: boolean;
}

export type ForYouDecision = "bookmark" | "hide" | "leave";

export interface ForYouScoreResult {
  rule: number | null;
  vector: number | null;
  final: number;
  decision: ForYouDecision;
  reasons: string[];
}

/** 自动收藏的推文追加的标签（M2 落库时用；M1 仅作常量） */
export const FORYOU_AUTO_TAG = "auto";

/** 打分权重（设计 §3.2，v1 固定不开放调参） */
export const FORYOU_RULE_TOPIC_WEIGHT = 0.55;
export const FORYOU_RULE_AUTHOR_WEIGHT = 0.25;
export const FORYOU_RULE_ENGAGEMENT_WEIGHT = 0.2;

export const FORYOU_BOOKMARK_THRESHOLD_DEFAULT = 0.7;
/** 用户已确认：初期保守 0.15（设计 §3.1 写的是 0.25，已被 2026-11-19 的决定覆盖） */
export const FORYOU_HIDE_THRESHOLD_DEFAULT = 0.15;
/** 长期默认值 20；试跑期初始值 5（用户已确认 2026-11-19） */
export const FORYOU_DAILY_CAP_DEFAULT = 20;
export const FORYOU_DAILY_CAP_TRIAL = 5;
export const FORYOU_MIN_GAP_MS_DEFAULT = 5000;
export const FORYOU_MAX_TOPICS = 30;
export const FORYOU_MAX_KEYWORDS_PER_TOPIC = 50;

/** 一键导入的预设话题：2026-11-08 用户提议的 9 个标签（仅作模板，不假设它们已在库里）。 */
export const DEFAULT_TOPIC_PRESETS: { label: string; keywords: string[] }[] = [
  { label: "AI/技术", keywords: ["AI", "人工智能", "LLM", "大模型", "agent", "智能体", "Claude", "ChatGPT"] },
  { label: "投资/股票", keywords: ["投资", "股票", "美股", "港股", "基金", "ETF", "财报"] },
  { label: "工具教程", keywords: ["教程", "工具", "效率", "工作流", "workflow", "技巧"] },
  { label: "新闻时事", keywords: ["新闻", "时事", "突发", "政策"] },
  { label: "生活", keywords: ["生活", "日常", "旅行", "美食", "健康"] },
  { label: "幽默", keywords: ["搞笑", "幽默", "段子", "meme"] },
  { label: "待读/收藏", keywords: ["收藏", "待读", "必读", "干货"] },
  { label: "广告/营销", keywords: ["广告", "营销", "推广", "带货"] },
  { label: "其他", keywords: [] },
];

export function defaultForYouSettings(): ForYouSettings {
  return {
    enabled: false,
    // M1 只有规则版；M3 向量版落地后再把默认改回 hybrid（设计 §4.2）。
    mode: "rule",
    bookmarkThreshold: FORYOU_BOOKMARK_THRESHOLD_DEFAULT,
    hideThreshold: FORYOU_HIDE_THRESHOLD_DEFAULT,
    showScoreChip: true,
    autoScroll: true,
    dailyCap: FORYOU_DAILY_CAP_TRIAL,
    minGapMs: FORYOU_MIN_GAP_MS_DEFAULT,
    destination: { kind: "folder", folder: "auto-foryou" },
    topics: [],
    languages: [],
    profileHalfLifeDays: 90,
    vetoCooldownDays: 14,
    // M3 的 embedding 配置；M1 只预留，不发起任何 embedding 请求。
    embed: { endpoint: "http://127.0.0.1:1234/v1", model: "bge-m3" },
    authorVetoes: [],
    keywordVetoes: [],
  };
}
