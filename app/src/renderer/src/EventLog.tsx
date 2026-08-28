// 事件流水：把脚本 JSONL 事件翻译为可读行，实时滚动
import { useEffect, useRef } from 'react'
import type { ScriptEvent } from '@shared/types'
import { isKnownEvent } from '@shared/types'

type Tone = 'ok' | 'warn' | 'fail' | 'info'

export function eventLine(ev: ScriptEvent): { text: string; tone: Tone } | null {
  if (!isKnownEvent(ev)) return null
  switch (ev.event) {
    case 'hello':
      return null
    case 'detect':
      return ev.ok
        ? { text: `识别 ${ev.vpn} → ${ev.interface} (${ev.method})`, tone: 'ok' }
        : { text: `${ev.vpn} 未检测到`, tone: 'fail' }
    case 'phase': {
      const names: Record<string, string> = { dns: '设置 DNS', cleanup: '清理旧路由', gateway: '修正默认网关' }
      return { text: `${names[ev.step] ?? ev.step} ${ev.ok ? '✓' : '✗'} ${ev.detail}`, tone: ev.ok ? 'ok' : 'fail' }
    }
    case 'route': {
      const verb = ev.action === 'add' ? '添加' : '删除'
      const via = ev.interface ? ` → ${ev.interface}` : ''
      return { text: `${verb} ${ev.kind === 'net' ? '网段' : '主机'} ${ev.target}${via} ${ev.ok ? '✓' : '✗'}`, tone: ev.ok ? 'ok' : 'warn' }
    }
    case 'apply_start':
      return { text: `开始 Apply（${ev.vpn_count} 个 VPN）`, tone: 'info' }
    case 'apply_end':
      return { text: `Apply ${ev.ok ? '完成 ✓' : '失败 ✗'}`, tone: ev.ok ? 'ok' : 'fail' }
    case 'apply_abort':
      return { text: `中止：未连接 ${ev.missing.join('、')}`, tone: 'fail' }
    case 'clean_start':
      return { text: '开始 Clean', tone: 'info' }
    case 'clean_end':
      return { text: `Clean ${ev.ok ? '完成 ✓' : '失败 ✗'}`, tone: ev.ok ? 'ok' : 'fail' }
    case 'test_start':
      return { text: `连通性测试（${ev.count} 项）`, tone: 'info' }
    case 'test_item':
      return { text: `${ev.desc}: ${ev.detail}`, tone: ev.result === 'ok' ? 'ok' : ev.result === 'warn' ? 'warn' : 'fail' }
    case 'test_end':
      return { text: `测试结束 ✓${ev.passed} ⚠${ev.warned} ✗${ev.failed}`, tone: ev.ok ? 'ok' : 'warn' }
    case 'summary':
      return { text: `汇总 ${ev.op}: ${ev.ok ? '正常' : '有失败项'}`, tone: ev.ok ? 'ok' : 'warn' }
    case 'error':
      return { text: `[${ev.code}] ${ev.message}`, tone: 'fail' }
    case 'auto':
      if (ev.action === 'apply-triggered') return { text: `⚡ 自动 Apply：${ev.reason}`, tone: 'info' }
      if (ev.action === 'evaluating') return { text: `网络变化，评估中…`, tone: 'info' }
      return { text: `自动 Apply 跳过：${ev.reason}`, tone: 'warn' }
    case 'status':
      return null // 状态卡片已展示，不进流水
    default:
      return null
  }
}

export default function EventLog({ events }: { events: ScriptEvent[] }): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [events])

  const lines = events.map(eventLine).filter((l): l is { text: string; tone: Tone } => l !== null).slice(-100)

  return (
    <section className="card">
      <div className="card-title">事件流水</div>
      <div className="eventlog" ref={boxRef}>
        {lines.length === 0 && <div className="ev-empty">暂无事件</div>}
        {lines.map((l, i) => (
          <div key={i} className={`ev tone-${l.tone}`}>
            {l.text}
          </div>
        ))}
      </div>
    </section>
  )
}
