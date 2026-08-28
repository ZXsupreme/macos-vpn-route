// GUI 与 vpn_route.sh 的唯一边界：执行脚本、逐行解析 JSONL 事件流
// 两种执行模式：
//   direct        —— 以当前用户直接跑（status/test 无需 root；osascript 降级时由 sudoRunner 包裹）
//   sudo-nopasswd —— sudo -n 跑 root 安装副本（apply/clean 主路径，参数与 sudoers 条目逐字一致）
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type { ScriptEvent, ScriptOp } from '../shared/types'
import { INSTALLED_SCRIPT, sourceScriptPath } from './sudoManager'

export type ExecMode = 'direct' | 'sudo-nopasswd'

export interface RunOutcome {
  code: number
  stderr: string
  events: ScriptEvent[]
}

export interface RunOptions {
  /** JSONL 每行事件回调（流式，用于 UI 实时滚动） */
  onEvent?: (ev: ScriptEvent) => void
  /** 覆盖配置文件路径（-c 参数） */
  confPath?: string
  /** 执行模式（默认 direct） */
  mode?: ExecMode
}

// 脚本路径：安装副本（root 所有）优先，开发副本兜底；安装/卸载后 resetScriptCache()
let cachedScript: string | null = null
export function scriptPath(): string {
  if (!cachedScript) cachedScript = existsSync(INSTALLED_SCRIPT) ? INSTALLED_SCRIPT : sourceScriptPath()
  return cachedScript
}
export function resetScriptCache(): void {
  cachedScript = null
}

/** 运行脚本子命令（--json 模式）。GUI 进程 PATH 极简，必须显式指定 */
export function runScript(op: ScriptOp, opts: RunOptions = {}): Promise<RunOutcome> {
  return new Promise((resolve, reject) => {
    const conf = opts.confPath
    let cmd: string
    let args: string[]
    if (opts.mode === 'sudo-nopasswd') {
      // 参数顺序与 /etc/sudoers.d/vpnroutebar 条目严格一致，勿改
      cmd = '/usr/bin/sudo'
      args = ['-n', scriptPath(), op]
      if (conf) args.push('-c', conf)
      args.push('--json')
    } else {
      cmd = '/bin/bash'
      args = [scriptPath(), op]
      if (conf) args.push('-c', conf)
      args.push('--json')
    }

    const child = spawn(cmd, args, {
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: process.env.HOME ?? homedir(),
        LANG: 'en_US.UTF-8'
      }
    })

    const events: ScriptEvent[] = []
    let stderr = ''
    let settled = false

    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      const s = line.trim()
      if (!s) return
      try {
        const ev = JSON.parse(s) as ScriptEvent
        events.push(ev)
        opts.onEvent?.(ev)
      } catch {
        // 意外泄漏的非 JSON 行：吞掉但保留到 stderr 便于排查
        stderr += `[leaked] ${s}\n`
      }
    })

    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024)
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      reject(err)
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      resolve({ code: code ?? -1, stderr, events })
    })
  })
}

/** 是否有脚本操作正在运行（单飞互斥） */
let running = false
export function isRunning(): boolean {
  return running
}
export function setRunning(v: boolean): void {
  running = v
}
