// 定时巡检：周期 status（VPN 缺失跳过 test 直接标 degraded，防 8 项 × 超时等待黑洞），
// VPN 全在才跑 test 并做失败变化沿告警；与手动操作共用单飞闸门
import { getSettings } from './settings'
import { isRunning } from './scriptRunner'
import { runReadonlyOp } from './ipc'
import { snapshot } from './appState'
import { notifyFailureChange, notifyVpnMissing } from './notifier'

let timer: NodeJS.Timeout | undefined

export function startPatrol(): void {
  stopPatrol()
  const s = getSettings()
  if (!s.patrolEnabled) return
  timer = setInterval(() => void patrolTick(), s.patrolIntervalSeconds * 1000)
  console.log(`[vpnroute] patrol started (${s.patrolIntervalSeconds}s)`)
}

export function stopPatrol(): void {
  if (timer) {
    clearInterval(timer)
    timer = undefined
  }
}

/** 设置变化后重启（间隔/开关可能变了） */
export function restartPatrol(): void {
  startPatrol()
}

async function patrolTick(): Promise<void> {
  const s = getSettings()
  if (!s.patrolEnabled || isRunning()) return

  const r = await runReadonlyOp('status')
  if (!r.ok) return
  const st = snapshot().status
  if (!st) return

  const missing = st.vpns.filter((v) => !v.detected).map((v) => v.name)
  if (missing.length > 0) {
    // VPN 缺失：跳过 test（等待黑洞），status 已把图标标 degraded；通知走变化沿
    notifyVpnMissing(missing)
    return
  }
  notifyVpnMissing([]) // 全在：清空缺失状态（触发恢复通知沿）

  await runReadonlyOp('test')
  notifyFailureChange(snapshot().lastTests)
}
