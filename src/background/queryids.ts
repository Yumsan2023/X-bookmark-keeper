import { DEFAULT_QUERY_IDS, type OperationName, type QueryIdMap } from '@/api/endpoints'
import { discoverQueryIds } from '@/api/queryid-discovery'
import { getLearnedQueryIds, saveLearnedQueryIds } from '@/shared/storage'

/** 优先级: 页面请求学到/脚本扫描到的 (storage) > 写死默认值 */
export async function getQueryId(op: OperationName): Promise<string> {
  const learned = await getLearnedQueryIds()
  return learned[op] ?? DEFAULT_QUERY_IDS[op]
}

export async function getAllQueryIds(): Promise<Record<OperationName, { id: string; source: 'learned' | 'default' }>> {
  const learned = await getLearnedQueryIds()
  const out = {} as Record<OperationName, { id: string; source: 'learned' | 'default' }>
  for (const op of Object.keys(DEFAULT_QUERY_IDS) as OperationName[]) {
    out[op] = learned[op] ? { id: learned[op]!, source: 'learned' } : { id: DEFAULT_QUERY_IDS[op], source: 'default' }
  }
  return out
}

let refreshing: Promise<boolean> | null = null

/** 从 x.com JS bundle 重新扫描 queryId。返回是否有任何值发生变化 */
export function refreshQueryIds(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const found = await discoverQueryIds()
      const before = await getLearnedQueryIds()
      const merged: QueryIdMap = { ...before, ...found }
      const changed = (Object.keys(found) as OperationName[]).some((op) => (before[op] ?? DEFAULT_QUERY_IDS[op]) !== found[op])
      if (Object.keys(found).length) await saveLearnedQueryIds(merged)
      return changed
    } catch {
      return false
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}
