/**
 * For You 规则版打分（M1）。
 * 纯函数：不读 chrome.*、不读 DOM、不读库，全部输入由调用方（store.js）传入，
 * 所以可以直接用 vitest 测（设计 §3.2、§9）。
 *
 * M1 已实现：规则打分 scoreRule、规则/向量混合 blend（向量缺失时退化为规则）、
 * 决策 decide、余弦 cosine。
 * M1 未实现（留给 M3/M4，见各函数注释）：向量打分 scoreVector、画像构建、
 * Strike 之外的 veto（作者/关键词 veto 由 M4 的反馈写入）。
 */
import { tokenize } from "@/search/tokenizer";
import {
  FORYOU_RULE_AUTHOR_WEIGHT,
  FORYOU_RULE_ENGAGEMENT_WEIGHT,
  FORYOU_RULE_TOPIC_WEIGHT,
  type ForYouDecision,
  type ForYouMode,
  type ForYouScoreContext,
  type ForYouScoreInput,
  type ForYouScoreResult,
  type ForYouTopic,
} from "./types";

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const norm = (s: string) => s.normalize("NFKC").toLowerCase();

/** ASCII 词（字母数字下划线）走 token 精确匹配，避免 "ai" 命中 "said" 这类子串误伤。 */
const ASCII_WORD = /^[a-z0-9_]+$/;
/** 含 CJK 字符的关键词走子串匹配（分词器对 CJK 不可靠）。 */
const HAS_CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keywordHit(keyword: string, textNorm: string, tokens: ReadonlySet<string>): boolean {
  const kw = norm(keyword).trim();
  if (!kw) return false;
  if (ASCII_WORD.test(kw)) return tokens.has(kw);
  if (HAS_CJK.test(kw)) return textNorm.includes(kw);
  // 多词英文等：词边界子串匹配。
  return new RegExp(`(^|[^a-z0-9_])${escapeRegExp(kw)}([^a-z0-9_]|$)`, "i").test(textNorm);
}

export interface RuleScore {
  score: number;
  /** 命中话题的 id（按话题在配置中的顺序）；用于 badge 提示与 M4 诊断 */
  hitTopicIds: string[];
  reasons: string[];
}

/**
 * 规则版打分（设计 §3.2）：
 * rule = clamp(0,1, 0.55×topic + 0.25×author + 0.20×engagement)。
 * - topic：每话题 hitStrength = min(1, 去重关键词命中数 / 2)（2 命中即饱和），
 *   topicScore = max(weight × hitStrength)；未配置话题时 topicScore 为 0。
 * - author：已关注 +0.30，常收藏作者 +0.40（需 M3 画像；M1 传 null），
 *   Strike 白名单 +0.20，上限 0.90。
 * - engagement：M1 取不到库互动中位数（需 M3 画像），一律中性 0.5。
 */
export function scoreRule(input: ForYouScoreInput, ctx: ForYouScoreContext): RuleScore {
  const fullText = [input.text || "", input.quotedText || ""].filter(Boolean).join("\n");
  const textNorm = norm(fullText);
  const tokens = new Set(tokenize(fullText));
  const reasons: string[] = [];

  let topic = 0;
  const hitTopicIds: string[] = [];
  for (const topicCfg of ctx.topics || []) {
    const hits = new Set<string>();
    for (const keyword of topicCfg.keywords || []) {
      if (keywordHit(keyword, textNorm, tokens)) hits.add(norm(keyword).trim());
    }
    if (hits.size === 0) continue;
    const strength = Math.min(1, hits.size / 2);
    topic = Math.max(topic, (topicCfg.weight ?? 1) * strength);
    hitTopicIds.push(topicCfg.id);
    reasons.push(`topic:${topicCfg.id}`);
  }

  let author = 0;
  if (input.followed === true) {
    author += 0.3;
    reasons.push("followed");
  }
  if (ctx.topAuthors && ctx.topAuthors.has((input.handle || "").toLowerCase())) {
    author += 0.4;
    reasons.push("top-author");
  }
  if (ctx.whitelist) {
    author += 0.2;
    reasons.push("whitelist");
  }
  author = Math.min(author, 0.9);

  // M1：互动中位数缺失，互动分中性 0.5。M3 画像建好后按
  // clamp(log10(1+likes)/log10(1+medianLikes), 0, 1) 计算。
  const engagement = engagementScore(input.likes ?? null, ctx.medianLikes ?? null);

  const score = clamp01(
    FORYOU_RULE_TOPIC_WEIGHT * topic +
      FORYOU_RULE_AUTHOR_WEIGHT * author +
      FORYOU_RULE_ENGAGEMENT_WEIGHT * engagement,
  );
  return { score, hitTopicIds, reasons };
}

/**
 * 互动分：缺失指标（likes 或 medianLikes 任一缺失）→ 中性 0.5；
 * 否则 clamp(log10(1+likes)/log10(1+medianLikes), 0, 1)。
 * 单独导出以便单测；scoreRule 在 M1 里总是走中性分支。
 */
export function engagementScore(likes: number | null | undefined, medianLikes: number | null | undefined): number {
  if (typeof likes !== "number" || !Number.isFinite(likes) || likes < 0) return 0.5;
  if (typeof medianLikes !== "number" || !Number.isFinite(medianLikes) || medianLikes <= 0) return 0.5;
  return clamp01(Math.log10(1 + likes) / Math.log10(1 + medianLikes));
}

/**
 * 决策（设计 §3.1）：final >= bookmarkThreshold → bookmark；
 * final <= hideThreshold → hide；否则 leave。
 * Strike 一票否决（作者 Spam/Marketing/Vagueposting 达阈值）时强制 hide，
 * 永不自动收藏（M2 执行时同样要以此为准）。
 */
export function decide(
  final: number,
  opts: { bookmarkThreshold: number; hideThreshold: number; strikeVeto: boolean },
): ForYouDecision {
  if (opts.strikeVeto) return "hide";
  if (final >= opts.bookmarkThreshold) return "bookmark";
  if (final <= opts.hideThreshold) return "hide";
  return "leave";
}

/**
 * 规则/向量混合（设计 §3.3）：
 * - vector：向量分直接作 final（M3 才有）。
 * - hybrid：0.5×rule + 0.5×vector（M3 才有）。
 * - rule，或 vector 为 null（M3 画像未建好）时自动退化为规则版；rule 为 null 时 0。
 */
export function blend(
  rule: number | null,
  vector: number | null,
  mode: ForYouMode,
): { rule: number | null; vector: number | null; final: number } {
  if (mode === "vector" && vector != null) return { rule, vector, final: clamp01(vector) };
  if (mode === "hybrid" && rule != null && vector != null) {
    return { rule, vector, final: clamp01(0.5 * rule + 0.5 * vector) };
  }
  return { rule, vector, final: clamp01(rule ?? 0) };
}

/** 余弦相似度（M3 画像相似度计算用；M1 先实现并单测）。长度不等或零向量时返回 0。 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 一次打分的完整组合：规则分 → 混合（M1 向量为 null）→ 决策。
 * store.js 的 FORYOU_SCORE 就是调这个；调用方负责在 ctx 里放好
 * topics / whitelist / topAuthors / medianLikes，并算好 strikeVeto。
 */
export function scoreCandidate(
  input: ForYouScoreInput,
  ctx: ForYouScoreContext,
  opts: { mode: ForYouMode; bookmarkThreshold: number; hideThreshold: number; strikeVeto: boolean },
): ForYouScoreResult {
  const { score: rule, reasons } = scoreRule(input, ctx);
  // M1：没有向量画像，vector 恒为 null，blend 自动退化为规则版。
  const { vector, final } = blend(rule, null, opts.mode);
  const decision = decide(final, opts);
  return { rule, vector, final, decision, reasons };
}

export type { ForYouTopic };
