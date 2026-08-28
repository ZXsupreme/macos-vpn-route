// 主进程集中状态：ingest 脚本事件 → 派生 phase（逻辑单源，bash 只报事实）
import type { Phase, ScriptEvent, StatusReport, TestItem, TestSummary } from '../shared/types'
import { isKnownEvent } from '../shared/types'

export interface AppStateSnapshot {
  phase: Phase
  status: StatusReport | null
  lastTests: TestItem[]
  lastSummary: TestSummary | null
  lastError: string | null
}

let phase: Phase = 'unknown'
let status: StatusReport | null = null
let lastTests: TestItem[] = []
let lastSummary: TestSummary | null = null
let lastError: string | null = null
/** 当前运行中的操作（busy 态来源；null = 空闲） */
let busyOp: string | null = null
let checking = false

export function snapshot(): AppStateSnapshot {
  return { phase, status, lastTests, lastSummary, lastError }
}

export function setBusy(op: string | null): void {
  busyOp = op
  recompute()
}

export function setChecking(v: boolean): void {
  checking = v
  recompute()
}

/** 吸收一个脚本事件，更新本地状态（未知事件忽略） */
export function ingestEvent(ev: ScriptEvent): void {
  if (!isKnownEvent(ev)) return
  switch (ev.event) {
    case 'status':
      status = ev
      break
    case 'test_item':
      // 流式替换同 index 项（apply 内嵌 test 与独立 test 共用）
      {
        const idx = lastTests.findIndex((t) => t.index === ev.index)
        if (idx >= 0) lastTests[idx] = ev
        else lastTests.push(ev)
        lastTests.sort((a, b) => a.index - b.index)
      }
      break
    case 'test_start':
      lastTests = []
      lastError = null
      break
    case 'test_end':
      lastSummary = { passed: ev.passed, warned: ev.warned, failed: ev.failed, ok: ev.ok }
      break
    case 'error':
      lastError = `[${ev.code}] ${ev.message}`
      break
    default:
      break
  }
  recompute()
}

/** 状态机（计划 §2.8）：busy > checking > failed > degraded > ok > unknown */
function recompute(): void {
  const prev = phase
  if (busyOp) {
    phase = 'busy'
  } else if (checking) {
    phase = 'checking'
  } else if (lastError) {
    phase = 'failed'
  } else if (!status) {
    phase = 'unknown'
  } else if (lastSummary && lastSummary.failed > 0) {
    phase = 'failed'
  } else {
    const allRoutesOk = status.vpns.every((v) => v.detected && v.routes.every((r) => r.ok))
    const hasWarn = lastSummary ? lastSummary.warned > 0 : false
    if (status.all_detected && allRoutesOk && !hasWarn) phase = 'ok'
    else phase = 'degraded'
  }
  if (prev !== phase) onPhaseChange?.(phase)
}

let onPhaseChange: ((p: Phase) => void) | null = null
export function setPhaseListener(cb: (p: Phase) => void): void {
  onPhaseChange = cb
  cb(phase) // 立即同步一次当前值
}
