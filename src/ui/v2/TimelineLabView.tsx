import { useEffect, useState } from 'react'
import { FlaskConical, Shield, Sparkles } from 'lucide-react'
import { ForYouPanel } from '../components/ForYouPanel'
import { StrikeLedgerView } from '../components/StrikeLedgerView'

export function TimelineLabView() {
  const [sub, setSub] = useState<'foryou' | 'strike'>('foryou')
  const [markBar, setMarkBar] = useState(false)
  const [hoverCard, setHoverCard] = useState(false)

  useEffect(() => {
    void chrome.storage.local.get('xsl').then((r) => {
      const s = (r.xsl as { settings?: Record<string, unknown> } | undefined)?.settings
      if (s) {
        setMarkBar(s.markBarEnabled === true)
        setHoverCard(s.hoverCardEnabled === true)
      }
    })
  }, [])

  const toggleStrikeDisplay = async (key: 'markBarEnabled' | 'hoverCardEnabled', value: boolean) => {
    if (key === 'markBarEnabled') setMarkBar(value)
    else setHoverCard(value)
    await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', patch: { [key]: value } })
  }

  return (
    <div className="mx-auto max-w-5xl px-5 py-3.5">
      <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
            <FlaskConical className="h-4 w-4 text-violet-400" />
            <span>时间线实验室（可选增强模块）</span>
          </h2>
          <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
            所有时间线注入默认保持无打扰（Mark 行与头像悬停卡默认关闭，仍可随时用 Alt+T / Alt+V 快捷键标记）。
          </p>
        </div>

        {/* Segmented toggle */}
        <div className="inline-flex rounded-lg border p-0.5" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
          <button
            type="button"
            onClick={() => setSub('foryou')}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors"
            style={{
              background: sub === 'foryou' ? 'var(--tab-active-bg)' : 'transparent',
              color: sub === 'foryou' ? 'var(--tab-active-fg)' : 'var(--muted)',
            }}
          >
            <Sparkles className="h-3.5 w-3.5" /> For You 智能策展
          </button>
          <button
            type="button"
            onClick={() => setSub('strike')}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors"
            style={{
              background: sub === 'strike' ? 'var(--tab-active-bg)' : 'transparent',
              color: sub === 'strike' ? 'var(--tab-active-fg)' : 'var(--muted)',
            }}
          >
            <Shield className="h-3.5 w-3.5" /> Strike Ledger 打击账本
          </button>
        </div>
      </div>

      {/* Quick non-intrusive X display switches right at the top — never buried again! */}
      <div className="v2-card mb-3.5 flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5 text-xs">
        <span className="font-medium">X 页面防打扰快速开关：</span>
        <div className="flex flex-wrap items-center gap-5">
          <label className="inline-flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={markBar}
              onChange={(e) => void toggleStrikeDisplay('markBarEnabled', e.target.checked)}
            />
            <span>在每条推文下显示 Mark 行（关闭仍可用 Alt+T / Alt+V）</span>
          </label>
          <label className="inline-flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={hoverCard}
              onChange={(e) => void toggleStrikeDisplay('hoverCardEnabled', e.target.checked)}
            />
            <span>悬停用户头像显示账本浮卡</span>
          </label>
        </div>
      </div>

      {sub === 'foryou' ? (
        <div>
          <div className="mb-4 rounded-xl border px-4 py-3 text-xs" style={{ background: 'var(--accent-soft)', borderColor: 'var(--border)' }}>
            <strong>v2.0 已修复 4 项 For You 引擎缺陷：</strong>① 时间线真实点赞解析 + Hybrid 高语义保底消除陌生新作者 0.65 上限盲区；② 本地 Embedding 移出互斥锁不再阻塞 Alt+T；③ CreateBookmark 出队二次原子校验每日上限；④ 拟人化字数阅读停留 + 单次会话 150 条自动熔断。
          </div>
          <div className="v2-legacy-wrap">
            <ForYouPanel />
          </div>
        </div>
      ) : (
        <div className="v2-legacy-wrap">
          <StrikeLedgerView />
        </div>
      )}
    </div>
  )
}
