// 特权执行：osascript "do shell script ... with administrator privileges"
// 系统弹密码框授权；脚本以 root 运行（其内部 sudo 因调用者已是 root 免密）
//
// 输出通路：osascript 的返回值是 AppleScript 字符串字面量（引号/换行转义不可靠），
// 故让脚本把 JSONL 重定向到临时文件，主进程增量 tail 流式解析，结束时只补读未消费部分。
import { spawn } from 'node:child_process'
import { open, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ScriptEvent } from '../shared/types'
import { scriptPath } from './scriptRunner'

export interface SudoRunOptions {
  onEvent?: (ev: ScriptEvent) => void
  confPath?: string
}

export interface SudoRunOutcome {
  code: number // 0 = osascript 成功；非 0 = 授权取消或失败
  cancelled: boolean
  error?: string
}

/** 以管理员权限运行 apply/clean（M5 后 sudoers NOPASSWD 成为主路径，此为降级模式） */
export function runScriptPrivileged(op: 'apply' | 'clean', opts: SudoRunOptions = {}): Promise<SudoRunOutcome> {
  return new Promise((resolve) => {
    const tmpFile = join(tmpdir(), `vpnroute-${op}-${process.pid}.jsonl`)
    const script = scriptPath()
    const conf = opts.confPath ?? `${process.env.HOME ?? ''}/.vpn_route.conf`

    // 路径均为固定无单引号路径；AppleScript 字符串内双引号需转义
    const shellCmd = `/bin/bash '${script}' ${op} -c '${conf}' --json > '${tmpFile}' 2>/dev/null`
    const appleScript = `do shell script "${shellCmd.replace(/"/g, '\\"')}" with administrator privileges`

    const tail = startTail(tmpFile, opts.onEvent)
    let settled = false

    const finish = async (outcome: SudoRunOutcome): Promise<void> => {
      if (settled) return
      settled = true
      try {
        await tail.drain() // 读尽未消费部分并删除临时文件
      } finally {
        resolve(outcome)
      }
    }

    const child = spawn('/usr/bin/osascript', ['-e', appleScript], {
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME ?? '' }
    })

    let stderr = ''
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('error', (err) => void finish({ code: -1, cancelled: false, error: String(err) }))
    child.on('close', (code) => {
      // AppleScript -128: 用户在密码框点了取消
      const cancelled = stderr.includes('-128') || stderr.includes('User canceled')
      void finish({ code: code ?? -1, cancelled, error: stderr.trim().slice(0, 300) })
    })
  })
}

interface TailHandle {
  drain: () => Promise<void>
}

/** 轮询临时文件增量解析；drain() 停止轮询、读尽尾部、删除文件 */
function startTail(path: string, onEvent?: (ev: ScriptEvent) => void): TailHandle {
  let offset = 0
  let stopped = false

  /** 读取 [start, end) 并解析完整行；只推进到最后一个换行符（残行留待下次） */
  const readFrom = async (start: number, endExclusive: number): Promise<number> => {
    const fh = await open(path, 'r')
    try {
      const len = endExclusive - start
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, start)
      const lastNl = buf.lastIndexOf(10)
      if (lastNl < 0) return start // 无完整行，不推进
      const text = buf.subarray(0, lastNl + 1).toString('utf8')
      for (const line of text.split('\n')) {
        const s = line.trim()
        if (!s) continue
        try {
          onEvent?.(JSON.parse(s) as ScriptEvent)
        } catch {
          /* 非 JSON 行忽略 */
        }
      }
      return start + lastNl + 1
    } finally {
      await fh.close()
    }
  }

  const poll = async (): Promise<void> => {
    while (!stopped) {
      try {
        const st = await stat(path)
        if (st.size > offset) offset = await readFrom(offset, st.size)
      } catch {
        /* 文件尚未创建 */
      }
      if (!stopped) await new Promise((r) => setTimeout(r, 400))
    }
  }
  void poll()

  return {
    drain: async () => {
      stopped = true
      await new Promise((r) => setTimeout(r, 450)) // 等最后一轮 poll 退出
      try {
        const st = await stat(path)
        if (st.size > offset) await readFrom(offset, st.size)
        await unlink(path)
      } catch {
        /* 文件不存在则忽略 */
      }
    }
  }
}
