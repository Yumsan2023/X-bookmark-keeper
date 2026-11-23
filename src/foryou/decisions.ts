/**
 * For You 决策日志（M2）：Dexie foryouDecisions 表的写入口。
 * 每条执行过的 bookmark 决策写一行（成功 / 失败都写，失败带 error），
 * 供 M4 的决策日志面板展示与一键撤销。行数上限 2,000，超了删最旧的
 * （设计 §4.1；7 天后清 vectorCache 的清理任务是 M4 的事）。
 */
import { db } from "@/db/db";
import type { ForYouDecisionRow } from "./types";

export const FORYOU_DECISIONS_CAP = 2000;

export async function recordForYouDecision(row: ForYouDecisionRow): Promise<void> {
  await recordForYouDecisions([row]);
}

/** 批量写决策行（打分每批 ≤20 条）：一次 bulkPut + 一次剪枝，避免每行都 count()。 */
export async function recordForYouDecisions(rows: ForYouDecisionRow[]): Promise<void> {
  if (!rows.length) return;
  await db.foryouDecisions.bulkPut(rows);
  const count = await db.foryouDecisions.count();
  if (count > FORYOU_DECISIONS_CAP) {
    const overflow = count - FORYOU_DECISIONS_CAP;
    const oldest = await db.foryouDecisions.orderBy("at").limit(overflow).primaryKeys();
    await db.foryouDecisions.bulkDelete(oldest as string[]);
  }
}

/** 7 天后清掉决策行的 vectorCache（设计 §4.1 控体积；M4 在反馈处理后顺手做一次）。 */
export async function pruneStaleForYouVectorCache(now: number = Date.now()): Promise<number> {
  const stale = await db.foryouDecisions
    .where("at")
    .below(now - 7 * 86_400_000)
    .filter((row) => Array.isArray(row.vectorCache) && row.vectorCache.length > 0)
    .toArray();
  if (!stale.length) return 0;
  await db.foryouDecisions.bulkPut(
    stale.map((row) => ({ ...row, vectorCache: undefined })),
  );
  return stale.length;
}
