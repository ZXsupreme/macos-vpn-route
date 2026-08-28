// conf 文件 IO：读 + 备份（保留 5 份）+ 预检（bash -n + status --json 语义校验）+ 原子替换
import { execFile } from 'node:child_process'
import { copyFile, readFile, readdir, rename, unlink, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { scriptPath } from './scriptRunner'
import { getSettings } from './settings'

export function confPath(): string {
  return getSettings().confPath
}

export async function loadConf(): Promise<{ text: string; mtimeMs: number }> {
  const p = confPath()
  const text = await readFile(p, 'utf8')
  const st = await stat(p)
  return { text, mtimeMs: st.mtimeMs }
}

function exec(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } }, (err, stdout, stderr) => {
      resolve({ code: err ? 1 : 0, out: `${stdout}${stderr}` })
    })
  })
}

/** 写回管线：备份 → tmp → 双预检 → 原子 rename。mtime 不符提示重载（防外部改动被覆盖） */
export async function saveConf(newText: string, expectedMtimeMs?: number): Promise<{ ok: boolean; error?: string }> {
  const p = confPath()
  const tmp = `${p}.tmp-${process.pid}`

  // 0. 外部改动检测
  if (expectedMtimeMs !== undefined) {
    try {
      const st = await stat(p)
      if (st.mtimeMs !== expectedMtimeMs) {
        return { ok: false, error: '配置文件已被外部修改，请重新加载后再保存' }
      }
    } catch {
      return { ok: false, error: `配置文件不存在: ${p}` }
    }
  }

  try {
    // 1. 备份（保留最近 5 份）
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15) // yyyymmddThhmmss
    const bak = `${p}.bak-${stamp}`
    await copyFile(p, bak).catch(() => undefined)
    const dir = join(p, '..')
    const baks = (await readdir(dir)).filter((f) => f.includes('.vpn_route.conf.bak-')).sort()
    while (baks.length > 5) {
      await unlink(join(dir, baks.shift()!)).catch(() => undefined)
    }

    // 2. 写 tmp
    await writeFile(tmp, newText, 'utf8')

    // 3a. bash 语法预检
    const syntax = await exec('/bin/bash', ['-n', tmp])
    if (syntax.code !== 0) {
      await rename(tmp, `${tmp}.bad`).catch(() => undefined)
      return { ok: false, error: `bash 语法错误: ${syntax.out.trim().slice(0, 200)}` }
    }

    // 3b. 配置语义预检：status --json 退出码 != 2（2 = 配置错误）
    const semantic = await exec('/bin/bash', [scriptPath(), 'status', '-c', tmp, '--json'])
    if (semantic.code === 2) {
      await rename(tmp, `${tmp}.bad`).catch(() => undefined)
      return { ok: false, error: '配置语义校验失败（VPN_NAMES 为空或文件不可读）' }
    }

    // 4. 原子替换
    await rename(tmp, p)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}
