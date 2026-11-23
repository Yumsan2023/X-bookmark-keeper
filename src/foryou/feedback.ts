/**
 * For You 反馈闭环 — 纯函数（M4，设计 §3.5）。
 * 不读库、不发请求：画像更新、veto 判定、关键词提取都可直接单测。
 * 写库（读/写 Dexie 画像行、改 xsl 的 veto 列表）由调用方
 *（store.js 的 FORYOU_FEEDBACK）做。
 */
import { tokenize } from "@/search/tokenizer";
import { normalizeVector } from "./profile";
import type { ForYouProfileRow } from "./types";

export type ForYouFeedbackKind = "like" | "dislike";

/**
 * dislike 的 Top 3 关键词（设计 §3.5）。
 * 优先用用户自己配的话题关键词（多字词，如「人工智能」）：它们是用户
 * 的原词，veto 时不会像分词器的 2 字碎片（「人工」「智能」）那样误伤
 * 一大片；命中按词长降序排。名额有剩再按分词出现次数补（同次按词本身
 * 排序），只留长度 ≥2 的词（单字 CJK 噪音太大）。
 * 返回小写归一化后的词；调用方按 vetoCooldownDays 写 until。
 */
export function topFeedbackTokens(text: string, n = 3, topicKeywords: readonly string[] = []): string[] {
  const hay = (text || "").normalize("NFKC").toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();
  const topicHits = [...new Set(topicKeywords.map((k) => (k || "").normalize("NFKC").toLowerCase().trim()))]
    .filter((k) => k.length >= 2 && hay.includes(k))
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  for (const k of topicHits) {
    if (out.length >= n) break;
    out.push(k);
    seen.add(k);
  }
  if (out.length < n) {
    const counts = new Map<string, number>();
    for (const token of tokenize(text || "")) {
      const t = token.normalize("NFKC").toLowerCase().trim();
      // 已选关键词的子串（如「人工智能」里的「人工」）不补——那只是分词碎片。
      if (t.length < 2 || seen.has(t) || out.some((k) => k.includes(t))) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    for (const [t] of [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      if (out.length >= n) break;
      out.push(t);
      seen.add(t);
    }
  }
  return out.slice(0, Math.max(0, n));
}

/**
 * like：向量并入全局质心（增量均值，权重 1.0；设计 §3.5）。
 * 权重从 sampleSize + 已有 likeCount 起算（旧画像没有 likeCount 时按 0 计），
 * tagCentroids 不动；返回新画像行（调用方写回 Dexie）。
 */
export function applyLikeFeedback(profile: ForYouProfileRow, embedding: readonly number[]): ForYouProfileRow {
  const weight = Math.max(0, profile.sampleSize) + (profile.likeCount ?? 0);
  const dim = profile.globalCentroid.length;
  if (!dim || embedding.length !== dim) return profile;
  const next = profile.globalCentroid.map((v, i) => (v * weight + (embedding[i] ?? 0)) / (weight + 1));
  return { ...profile, globalCentroid: normalizeVector(next), likeCount: (profile.likeCount ?? 0) + 1 };
}

/**
 * dislike：向量并入负质心（增量均值，negCount+1；设计 §3.5）。
 * 第一次 dislike 时 negCentroid 为 null，直接取该向量（已归一化最好，
 * 未归一化也在这里归一化，保证之后 cosine 的分母有意义）。
 */
export function applyDislikeFeedback(profile: ForYouProfileRow, embedding: readonly number[]): ForYouProfileRow {
  const dim = profile.globalCentroid.length;
  if (!dim || embedding.length !== dim) return profile;
  const count = profile.negCount ?? 0;
  const prev = profile.negCentroid?.length === dim ? profile.negCentroid : null;
  const next =
    prev == null
      ? normalizeVector([...embedding])
      : normalizeVector(prev.map((v, i) => (v * count + (embedding[i] ?? 0)) / (count + 1)));
  return { ...profile, negCentroid: next, negCount: count + 1 };
}

/** 把一条反馈向量并入画像（like → 全局质心，dislike → 负质心）。 */
export function updateCentroidWithFeedback(
  profile: ForYouProfileRow,
  embedding: readonly number[],
  kind: ForYouFeedbackKind,
): ForYouProfileRow {
  return kind === "like" ? applyLikeFeedback(profile, embedding) : applyDislikeFeedback(profile, embedding);
}

/** 过滤掉已过期的 veto（until <= now），保留未过期的；顺序不变。 */
export function pruneExpiredVetoes<T extends { until: number }>(vetoes: readonly T[] | null | undefined, now: number): T[] {
  return (vetoes || []).filter((v) => Number(v?.until) > now);
}

/** 作者 veto 去重并续期：同一作者只留一条，until 取新的冷却截止。 */
export function upsertAuthorVeto(
  vetoes: { handle: string; until: number }[],
  handle: string,
  until: number,
): { handle: string; until: number }[] {
  const want = (handle || "").toLowerCase();
  if (!want) return vetoes;
  return [...vetoes.filter((v) => (v.handle || "").toLowerCase() !== want), { handle: want, until }];
}

/** 关键词 veto 去重并续期：同一关键词只留一条，until 取新的冷却截止。 */
export function upsertKeywordVetoes(
  vetoes: { keyword: string; until: number }[],
  keywords: readonly string[],
  until: number,
): { keyword: string; until: number }[] {
  const out = [...vetoes];
  for (const raw of keywords) {
    const kw = (raw || "").normalize("NFKC").toLowerCase().trim();
    if (kw.length < 2) continue;
    const idx = out.findIndex((v) => (v.keyword || "").toLowerCase() === kw);
    if (idx >= 0) out[idx] = { keyword: kw, until };
    else out.push({ keyword: kw, until });
  }
  return out;
}
