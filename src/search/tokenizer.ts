/**
 * 中英文混合分词: Intl.Segmenter('zh', word) + 小写 + NFKC。
 * 无 Segmenter 的环境退化为按非字母数字切分 + CJK 单字切分。
 */
let segmenter: Intl.Segmenter | null | undefined

function getSegmenter(): Intl.Segmenter | null {
  if (segmenter !== undefined) return segmenter
  try {
    segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter('zh', { granularity: 'word' }) : null
  } catch {
    segmenter = null
  }
  return segmenter
}

const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/

export function tokenize(text: string): string[] {
  if (!text) return []
  const norm = text.normalize('NFKC').toLowerCase()
  const seg = getSegmenter()
  const out: string[] = []
  if (seg) {
    for (const s of seg.segment(norm)) {
      if (s.isWordLike) out.push(s.segment)
    }
    return out
  }
  for (const part of norm.split(/[^\p{L}\p{N}_]+/u)) {
    if (!part) continue
    if (CJK.test(part)) for (const ch of part) out.push(ch)
    else out.push(part)
  }
  return out
}

export function hasCjk(s: string): boolean {
  return CJK.test(s)
}
