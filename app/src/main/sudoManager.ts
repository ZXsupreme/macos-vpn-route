// sudoers 免密授权管理（安全设计见计划 §2.6）：
// - sudo 只执行 root 拥有的安装副本（杜绝"用户可写脚本被 sudo 白名单"的经典提权）
// - sudoers 条目精确钉死参数、无通配符（-c 显式路径：sudo env_reset 会重置 HOME）
// - 只白名单脚本整跑 apply/clean，不白名单内部 route/networksetup
// - 安装前 visudo -cf 语法校验；tmp+mv 原子落位；sudo -n -l 无副作用探测生效性
import { execFile, spawn } from 'node:child_process'
import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { getSettings } from './settings'
import { allConfPaths } from './profiles'

export const INSTALL_DIR = '/Library/Application Support/VPNRouteBar'
export const INSTALLED_SCRIPT = `${INSTALL_DIR}/vpn_route.sh`
const SUDOERS_FILE = '/etc/sudoers.d/vpnroutebar'
const SUDOERS_TMP = '/etc/sudoers.d/vpnroutebar.tmp'

/** 源脚本：打包态从 app 资源取（extraResources/vpn_route.sh）；开发态从本仓库工作副本取 */
export function sourceScriptPath(): string {
  if (process.env.VPN_ROUTE_SCRIPT) return process.env.VPN_ROUTE_SCRIPT
  if (app.isPackaged) return join(process.resourcesPath, 'vpn_route.sh')
  return join(homedir(), 'Script', 'macos-vpn-route', 'vpn_route.sh')
}

async function sudoersContent(): Promise<string> {
  const user = process.env.USER ?? 'unknown'
  // 为全部 Profile 生成条目：切换 conf 后免密仍有效（新增 conf 文件需重装一次授权）
  const confs = await allConfPaths()
  const lines = [
    '# Managed by VPNRouteBar. 请勿手改；卸载请在应用设置里操作或删除本文件',
    `# 每个配置 Profile 两条（apply/clean），参数与 GUI 调用逐字一致`
  ]
  for (const conf of confs) {
    // 注意：参数顺序与 scriptRunner 的 sudo 调用严格一致，禁止通配符
    lines.push(`${user} ALL=(root) NOPASSWD: ${INSTALLED_SCRIPT} apply -c ${conf} --json`)
    lines.push(`${user} ALL=(root) NOPASSWD: ${INSTALLED_SCRIPT} clean -c ${conf} --json`)
  }
  return `${lines.join('\n')}\n`
}

function sh(): string {
  return 'PATH=/usr/bin:/bin:/usr/sbin:/sbin; export PATH; '
}

/** 无副作用探测：sudo -n -l 且输出含安装副本路径（GUI 每次启动自检） */
export async function probeNopasswd(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('/usr/bin/sudo', ['-n', '-l'], { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) resolve(false) // 未配置时 "a password is required" → exit 1
      else resolve(`${stdout}${stderr}`.includes(INSTALLED_SCRIPT))
    })
  })
}

// 探测结果缓存（安装/卸载后失效重探）
let cachedProbe: boolean | null = null
export async function isNopasswdActive(force = false): Promise<boolean> {
  if (cachedProbe === null || force) cachedProbe = await probeNopasswd()
  return cachedProbe
}
export function invalidateNopasswd(): void {
  cachedProbe = null
}

function runAppleScript(shellCmd: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const apple = `do shell script "${shellCmd.replace(/"/g, '\\"')}" with administrator privileges`
    const child = spawn('/usr/bin/osascript', ['-e', apple], {
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME ?? '' }
    })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('error', (err) => resolve({ code: -1, stderr: String(err) }))
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }))
  })
}

export interface SudoInstallResult {
  ok: boolean
  cancelled?: boolean
  error?: string
}

/** 安装：root 脚本副本 + sudoers 免密条目（一次系统密码授权） */
export async function installSudoers(): Promise<SudoInstallResult> {
  // 1. 生成并 visudo 语法校验（无需 root）
  const localTmp = join(tmpdir(), 'vpnroutebar.sudoers')
  await writeFile(localTmp, await sudoersContent(), 'utf8')
  const check = await new Promise<{ code: number; out: string }>((resolve) => {
    execFile('/usr/sbin/visudo', ['-c', '-f', localTmp], { timeout: 8000 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` })
    })
  })
  if (check.code !== 0) {
    await unlink(localTmp).catch(() => undefined)
    return { ok: false, cancelled: false, error: `sudoers 语法校验失败: ${check.out.trim()}` }
  }

  // 2. 一次管理员授权完成全部安装（tmp+mv 原子落位）
  const cmd = [
    sh(),
    `mkdir -p '${INSTALL_DIR}'`,
    `cp '${sourceScriptPath()}' '${INSTALLED_SCRIPT}'`,
    `chown root:wheel '${INSTALLED_SCRIPT}'`,
    `chmod 755 '${INSTALLED_SCRIPT}'`,
    `cp '${localTmp}' '${SUDOERS_TMP}'`,
    `chown root:wheel '${SUDOERS_TMP}'`,
    `chmod 440 '${SUDOERS_TMP}'`,
    `mv '${SUDOERS_TMP}' '${SUDOERS_FILE}'`
  ].join(' && ')
  const r = await runAppleScript(cmd)
  await unlink(localTmp).catch(() => undefined)
  if (r.code !== 0) {
    const cancelled = r.stderr.includes('-128') || r.stderr.includes('User canceled')
    return { ok: false, cancelled, error: r.stderr.trim().slice(0, 300) }
  }

  // 3. 生效验证
  const active = await probeNopasswd()
  return active
    ? { ok: true }
    : { ok: false, cancelled: false, error: '安装完成但探测未生效，请重试或检查 /etc/sudoers.d/vpnroutebar' }
}

/** 仅更新 root 脚本副本（脚本源码更新后；需授权） */
export async function reinstallScript(): Promise<SudoInstallResult> {
  const cmd = [sh(), `cp '${sourceScriptPath()}' '${INSTALLED_SCRIPT}'`, `chown root:wheel '${INSTALLED_SCRIPT}'`, `chmod 755 '${INSTALLED_SCRIPT}'`].join(' && ')
  const r = await runAppleScript(cmd)
  if (r.code !== 0) {
    const cancelled = r.stderr.includes('-128') || r.stderr.includes('User canceled')
    return { ok: false, cancelled, error: r.stderr.trim().slice(0, 300) }
  }
  return { ok: true }
}

/** 卸载：删 sudoers（可选同时删脚本副本） */
export async function uninstallSudoers(alsoScript: boolean): Promise<SudoInstallResult> {
  const parts = [sh(), `rm -f '${SUDOERS_FILE}'`]
  if (alsoScript) parts.push(`rm -rf '${INSTALL_DIR}'`)
  const r = await runAppleScript(parts.join(' && '))
  if (r.code !== 0) {
    const cancelled = r.stderr.includes('-128') || r.stderr.includes('User canceled')
    return { ok: false, cancelled, error: r.stderr.trim().slice(0, 300) }
  }
  return { ok: true }
}
