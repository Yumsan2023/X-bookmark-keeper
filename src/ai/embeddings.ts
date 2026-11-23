/**
 * For You 向量版 — embeddings 客户端（M3，设计 §3.3）。
 * 照抄 src/ai/classify.ts 的请求形态，只换 path 和 body：
 * POST {endpoint}/embeddings {model, input: string[]}。
 * 只接受回环地址（127.0.0.1 / localhost / ::1）：推文文本不出本机。
 * 注意：用户的 9B 推理模型（DeepSeek-V4-Pro-Qwen3.5-9B）是 chat 模型，
 * 没有 embedding 输出头，不能用；向量版要用 bge-m3 这类 embedding 专用模型。
 */
import { isLoopbackEndpoint } from "./classify";

export const EMBED_BATCH_SIZE = 32;
const EMBED_MAX_ATTEMPTS = 3;
const EMBED_RETRY_DELAY_MS = 500;

export interface EmbedConfig {
  endpoint: string;
  model: string;
}

/** 未配置（端点/模型为空）或端点不是回环地址时 false。 */
export function embedConfigured(cfg: EmbedConfig | undefined | null): boolean {
  if (!cfg?.endpoint.trim() || !cfg.model.trim()) return false;
  return isLoopbackEndpoint(cfg.endpoint);
}

export function normalize(vec: readonly number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0 || !Number.isFinite(norm)) return [...vec].map(() => 0);
  return [...vec].map((v) => v / norm);
}

function parseEmbeddingsResponse(json: unknown): number[][] {
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error("embedding 响应格式不对：缺少 data 数组");
  const out: number[][] = [];
  for (const item of data) {
    const vec = (item as { embedding?: unknown } | null)?.embedding;
    if (!Array.isArray(vec) || !vec.every((v) => typeof v === "number")) {
      throw new Error("embedding 响应格式不对：data 项缺少 embedding 数组");
    }
    out.push([...vec]);
  }
  return out;
}

async function embedChunk(
  cfg: EmbedConfig,
  texts: string[],
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<number[][]> {
  const base = cfg.endpoint.replace(/\/+$/, "");
  let lastError: Error = new Error("embedding 请求失败");
  for (let attempt = 1; attempt <= EMBED_MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new Error("embedding 已取消");
    try {
      const res = await fetchImpl(`${base}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: cfg.model, input: texts }),
        signal,
      });
      if (!res.ok) throw new Error(`embedding HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return parseEmbeddingsResponse(await res.json());
    } catch (e) {
      lastError = e as Error;
      if (signal?.aborted) throw lastError;
      if (attempt < EMBED_MAX_ATTEMPTS) {
        await new Promise<void>((r) => setTimeout(r, EMBED_RETRY_DELAY_MS * attempt));
      }
    }
  }
  throw lastError;
}

/**
 * 批量取 embedding。空输入返回 []，不发请求。
 * 超过 EMBED_BATCH_SIZE 的输入按 32 条分块，每块失败重试 2 次
 * （共 3 次尝试）。返回顺序与输入一一对应。
 */
export async function embedBatch(
  cfg: EmbedConfig,
  texts: string[],
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
  onBatch?: (done: number, total: number) => void,
): Promise<number[][]> {
  if (!embedConfigured(cfg)) {
    throw new Error("embedding 未配置：端点只接受本机地址（127.0.0.1 / localhost），模型不能为空");
  }
  const clean = texts.map((t) => String(t ?? ""));
  if (!clean.length) return [];
  const out: number[][] = [];
  for (let i = 0; i < clean.length; i += EMBED_BATCH_SIZE) {
    if (signal?.aborted) throw new Error("embedding 已取消");
    const chunk = clean.slice(i, i + EMBED_BATCH_SIZE);
    const vecs = await embedChunk(cfg, chunk, fetchImpl, signal);
    if (vecs.length !== chunk.length) {
      throw new Error(`embedding 返回条数不对：要了 ${chunk.length} 条，只回了 ${vecs.length} 条`);
    }
    out.push(...vecs);
    onBatch?.(out.length, clean.length);
  }
  return out;
}
