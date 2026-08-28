// vpn_route.sh --json 事件流的类型定义（schema 1，与脚本 SCRIPT_VERSION 对应）
// bash 只报事实；phase 综合状态由主进程派生

export type TestResultKind = 'ok' | 'warn' | 'fail'

export interface RouteBinding {
  target: string
  kind: string // "net" | "host"
  expected: string | null
  actual: string | null
  ok: boolean
}

export interface VpnStatus {
  name: string
  detected: boolean
  method: string | null // "inet6" | "subnet" | null
  interface: string | null
  ipv4: string | null
  ipv6: string | null
  routes: RouteBinding[]
}

export interface DefaultRoute {
  interface: string
  gateway: string
}

export interface StatusReport {
  ts: string
  conf: string
  vpns: VpnStatus[]
  default_route: DefaultRoute | null
  all_detected: boolean
}

export interface TestItem {
  index: number
  desc: string
  target: string
  kind: string // "public" | "tcp" | "domain"
  port: number
  result: TestResultKind
  detail: string
  seconds: number
}

export interface TestSummary {
  passed: number
  warned: number
  failed: number
  ok: boolean
}

export type ScriptOp = 'status' | 'test' | 'apply' | 'clean'

export type KnownScriptEvent =
  | { event: 'hello'; schema: number; script_version: string }
  | ({ event: 'status' } & StatusReport)
  | { event: 'detect'; vpn: string; ok: boolean; method: string | null; interface: string | null }
  | { event: 'phase'; step: string; ok: boolean; detail: string }
  | {
      event: 'route'
      action: string // "add" | "delete"
      vpn: string | null
      kind: string
      target: string
      interface: string | null
      ok: boolean
    }
  | { event: 'apply_start'; vpn_count: number }
  | { event: 'apply_end'; ok: boolean }
  | { event: 'apply_abort'; reason: string; missing: string[] }
  | { event: 'clean_start' }
  | { event: 'clean_end'; ok: boolean }
  | { event: 'test_start'; count: number }
  | ({ event: 'test_item' } & TestItem)
  | ({ event: 'test_end' } & TestSummary)
  | {
      event: 'summary'
      op: string
      apply_ok: boolean | null
      passed: number
      warned: number
      failed: number
      ok: boolean
    }
  | { event: 'error'; code: string; message: string }
  /** 客户端合成事件（非脚本输出）：自动 Apply 决策，复用 evt:script 通道进事件流水 */
  | { event: 'auto'; action: 'evaluating' | 'apply-triggered' | 'skipped'; reason: string }

/** 前向兼容：schema 升级时未知事件透传不崩 */
export type ScriptEvent = KnownScriptEvent | { event: string; [k: string]: unknown }

/** 菜单栏图标综合状态（主进程派生，逻辑单源） */
export type Phase = 'unknown' | 'checking' | 'busy' | 'ok' | 'degraded' | 'failed'

export function isKnownEvent(ev: ScriptEvent): ev is KnownScriptEvent {
  const known = [
    'hello', 'status', 'detect', 'phase', 'route', 'apply_start', 'apply_end',
    'apply_abort', 'clean_start', 'clean_end', 'test_start', 'test_item',
    'test_end', 'summary', 'error', 'auto'
  ]
  return known.includes(ev.event)
}
