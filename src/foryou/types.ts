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
  /** M4 反馈 veto（xsl.settings.foryou.authorVetoes / keywordVetoes）。 */
  authorVetoes?: { handle: string; until: number }[];
  keywordVetoes?: { keyword: string; until: number }[];
  /** 判定 veto 是否过期用的时间（默认 Date.now()，单测可注入）。 */
  now?: number;
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

/**
 * M2：内容脚本判定为 bookmark 后交给后台执行的一条候选。
 * 文本来自内容脚本采集（parseArticle），是轻量记录的唯一文本来源；
 * 作者/互动等缺失字段由执行时补空值，下次书签同步时 mergePost() 补全。
 */
export interface ForYouBookmarkItem {
  tweetId: string;
  handle: string;
  text: string;
  quotedText?: string;
  followed: boolean | null;
  rule: number | null;
  vector: number | null;
  final: number;
  reasons: string[];
}

/**
 * M2：Dexie foryouDecisions 行（设计 §4.1）。
 * 比设计多两个执行态字段：status（这条是排队/已收藏/失败）与 error
 * （失败原因，M4 决策日志面板用来展示；不加就无法区分“已判收藏但
 * 执行失败”和“已收藏”）。feedback / vectorCache 留给 M4。
 */
export interface ForYouDecisionRow {
  tweet_id: string;
  at: number;
  rule: number | null;
  vector: number | null;
  final: number;
  decision: ForYouDecision;
  reasons: string[];
  /** '' = 直接进书签，否则为目标文件夹名 */
  destination: string;
  feedback?: "like" | "dislike" | null;
  status?: "queued" | "bookmarked" | "failed";
  error?: string;
  vectorCache?: number[];
  /** M4：决策日志面板展示用（M2 的执行日志没有作者/文本，面板只能看到 id）。 */
  handle?: string;
  /** 正文前 200 字符（面板展示用，不存全文）。 */
  textSnippet?: string;
}

/** M3 画像行（设计 §3.3/§4.1）：Dexie foryouProfile 只有 'profile' 一行。 */
export interface ForYouProfileRow {
  key: string;
  dim: number;
  model: string;
  endpoint: string;
  globalCentroid: number[];
  tagCentroids: Record<string, number[]>;
  negCentroid: number[] | null;
  negCount: number;
  topAuthors: string[];
  medianLikes: number | null;
  medianViews: number | null;
  sampleSize: number;
  holdoutIds: string[];
  builtAt: number;
  msTaken: number;
  /** M4 反馈用的 like 增量均值计数（缺失按 0 计，权重从 sampleSize 起算）。 */
  likeCount?: number;
}

/**
 * M4 验证报告行（设计 §3.4/§4.1）。
 * suggested 为 null 时表示不建议阈值：负样本不足（degraded=true，
 * 只给正样本分布）或没有任何组合满足 hide 误杀率 <5%。
 */
export interface ForYouValidationRow {
  id: string;
  at: number;
  mode: ForYouMode;
  nPos: number;
  nNeg: number;
  thresholds: { bookmark: number; hide: number; precision: number; recall: number; f1: number; hideKillRate: number }[];
  suggested: { bookmark: number; hide: number } | null;
  /** 负样本 <100 时为 true：只给正样本分布，不建议阈值（设计 §3.4）。 */
  degraded: boolean;
  /** 正样本分数中位数 / p10（degraded 时是唯一可用的信号）。 */
  posMedian: number | null;
  posP10: number | null;
  notes: string;
}

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
    // M3 向量版已落地，默认改回 hybrid（设计 §4.2）；画像未建好时
    // blend 自动退化为规则版，UI 上提示画像未建。
    mode: "hybrid",
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
