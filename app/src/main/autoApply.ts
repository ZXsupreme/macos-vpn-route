// 自动 Apply 协调器：网络变化 → 静默防抖 → status 评估 → 闸门 → 执行
// 核心原则："路由已正确则不动手"（靠真实需要而非冷却硬扛）+ 单飞互斥 + 冷却防拉锯
import type { ScriptEvent } from '../shared/types'
import { getSettings } from './settings'
import { isRunning } from './scriptRunner'
import { snapshot } from './appState'
import { runReadonlyOp } from './ipc'

/** 自动路径的执行器（M5 注入 NOPASSWD 实现；null = 授权未安装，自动 Apply 不可用） */
type AutoApplier = (confPath: string) => Promise<{ ok: boolean; code: number }>
let applier: AutoApplier | null = null
export function setAutoApplier(fn: AutoApplier | null): void {
  applier = fn
}

let settleTimer: NodeJS.Timeout | undefined
let lastAutoApplyAt = 0
let evaluating = false

function emit(ev: ScriptEvent): void {
  onAutoEvent?.(ev)
}
let onAutoEvent: ((ev: ScriptEvent) => void) | null = null
export function setAutoEventListener(cb: (ev: ScriptEvent) => void): void {
  onAutoEvent = cb
}

/** 网络变化事件入口：重置静默计时（风暴期间零动作） */
export function handleNetworkChange(): void {
  if (settleTimer) clearTimeout(settleTimer)
  const s = getSettings()
  if (!s.autoApplyEnabled) return
  settleTimer = setTimeout(() => void evaluate(), s.autoApplySettleSeconds * 1000)
}

/** 手动 apply 成功后调用：重置冷却起点（用户刚处理完，自动机制别立刻又动） */
export function noteManualApply(): void {
  lastAutoApplyAt = Date.now()
}

async function evaluate(): Promise<void> {
  if (evaluating || isRunning()) return // 有操作在跑：丢弃本次评估（下个网络事件自然再评估）
  evaluating = true
  try {
    const s = getSettings()

    // 1. 只读评估：拉最新 status（会同步面板/图标）
    const r = await runReadonlyOp('status')
    if (!r.ok) return
    const st = snapshot().status
    if (!st) return

    // 2. 状态评估
    const detected = st.vpns.filter((v) => v.detected)
    if (detected.length === 0) {
      emit({ event: 'auto', action: 'skipped', reason: '全部 VPN 已断开' })
      return
    }
    if (!st.all_detected) {
      emit({ event: 'auto', action: 'skipped', reason: `未连接: ${st.vpns.filter((v) => !v.detected).map((v) => v.name).join('、')}` })
      return
    }
    const mismatched = st.vpns.flatMap((v) => v.routes.filter((rr) => !rr.ok))
    if (mismatched.length === 0) {
      return // 路由全部正确：无事可做（最常见路径，静默）
    }

    // 3. 闸门
    if (!s.autoApplyEnabled) {
      emit({ event: 'auto', action: 'skipped', reason: '自动 Apply 已关闭' })
      return
    }
    if (!applier) {
      emit({ event: 'auto', action: 'skipped', reason: '未安装 NOPASSWD 授权（设置页安装后可用）' })
      return
    }
    const elapsed = (Date.now() - lastAutoApplyAt) / 1000
    if (elapsed < s.autoApplyCooldownSeconds) {
      emit({ event: 'auto', action: 'skipped', reason: `冷却中（${Math.ceil(s.autoApplyCooldownSeconds - elapsed)}s）` })
      return
    }

    // 4. 执行
    emit({ event: 'auto', action: 'apply-triggered', reason: `${mismatched.length} 条路由失配` })
    lastAutoApplyAt = Date.now()
    const out = await applier(s.confPath)
    console.log(`[vpnroute] auto-apply -> ok=${out.ok} code=${out.code}`)
  } catch (err) {
    console.error('[vpnroute] auto-apply evaluate failed:', err)
  } finally {
    evaluating = false
  }
}
