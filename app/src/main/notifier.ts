// 系统通知：失败变化沿去重（新失败/恢复各一次，持续失败 30 分钟上限一次）
import { Notification } from 'electron'
import type { TestItem } from '../shared/types'

const REPEAT_MS = 30 * 60 * 1000

let lastFailed = new Set<string>()
let lastMissing = new Set<string>()
let lastFailNotifyAt = 0

function send(title: string, body: string): void {
  if (!Notification.isSupported()) return
  try {
    new Notification({ title, body }).show()
  } catch (err) {
    console.error('[vpnroute] notify failed:', err)
  }
}

/** 测试结果变化沿：新失败立即告警；持续失败 30 分钟一次；恢复通知 */
export function notifyFailureChange(tests: TestItem[]): void {
  const failed = new Set(tests.filter((t) => t.result === 'fail').map((t) => t.desc))
  const fresh = [...failed].filter((d) => !lastFailed.has(d))
  const recovered = [...lastFailed].filter((d) => !failed.has(d))

  if (fresh.length > 0) {
    const lines = [`失败: ${fresh.join('、')}`]
    if (recovered.length) lines.push(`已恢复: ${recovered.join('、')}`)
    send('VPN 路由告警', lines.join('\n'))
    lastFailNotifyAt = Date.now()
  } else if (failed.size > 0 && Date.now() - lastFailNotifyAt > REPEAT_MS) {
    send('VPN 路由告警（持续）', `仍在失败: ${[...failed].join('、')}`)
    lastFailNotifyAt = Date.now()
  } else if (recovered.length > 0) {
    send('VPN 路由恢复', `已恢复: ${recovered.join('、')}`)
  }
  lastFailed = failed
}

/** VPN 连接状态变化沿：断开告警 / 重连恢复 */
export function notifyVpnMissing(names: string[]): void {
  const missing = new Set(names)
  const fresh = [...missing].filter((n) => !lastMissing.has(n))
  const recovered = [...lastMissing].filter((n) => !missing.has(n))

  if (fresh.length > 0) {
    send('VPN 已断开', `未连接: ${fresh.join('、')}`)
  } else if (recovered.length > 0 && missing.size === 0) {
    send('VPN 已恢复', `${recovered.join('、')} 重新在线`)
  }
  lastMissing = missing
}
