// IPC 路由：renderer 的唯一入口。事件经 evt:script / evt:phase 推送
import { ipcMain, app, nativeTheme } from 'electron'
import type { ScriptEvent, ScriptOp } from '../shared/types'
import { runScript, isRunning, setRunning, resetScriptCache } from './scriptRunner'
import { runScriptPrivileged } from './sudoRunner'
import { installSudoers, uninstallSudoers, reinstallScript, isNopasswdActive, invalidateNopasswd } from './sudoManager'
import { ingestEvent, setBusy, setChecking, setPhaseListener, snapshot } from './appState'
import { getPanel } from './panel'
import { setTrayPhase } from './tray'
import { noteManualApply, setAutoApplier } from './autoApply'
import { getSettings, saveSettings, type AppSettings } from './settings'
import { restartPatrol } from './patrol'
import { loadConf, saveConf } from './configStore'
import { listProfiles } from './profiles'
import { scanNetwork, applyLearned } from './networkLearner'

function broadcast(channel: string, payload: unknown): void {
  const win = getPanel()
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

/** 统一事件处理器：ingest 状态机 + 推送面板 */
function handleEvent(ev: ScriptEvent): void {
  ingestEvent(ev)
  broadcast('evt:script', ev)
}

/** 执行一个只读操作（status/test）：单飞、流式转发事件 */
export async function runReadonlyOp(op: Extract<ScriptOp, 'status' | 'test'>): Promise<{ ok: boolean; code: number; error?: string }> {
  if (isRunning()) return { ok: false, code: -1, error: 'busy' }
  setRunning(true)
  setChecking(true)
  try {
    const outcome = await runScript(op, { onEvent: handleEvent })
    console.log(`[vpnroute] ${op} -> exit=${outcome.code} events=${outcome.events.length}${outcome.stderr ? ` stderr=${outcome.stderr.trim().slice(0, 200)}` : ''}`)
    return { ok: outcome.code === 0, code: outcome.code }
  } catch (err) {
    console.error(`[vpnroute] ${op} failed:`, err)
    return { ok: false, code: -1, error: String(err) }
  } finally {
    setChecking(false)
    setRunning(false)
  }
}

/**
 * 执行特权操作（apply/clean）：
 * NOPASSWD 已安装 → sudo -n 安装副本（无弹窗）；否则 osascript 授权降级（每次输密码）。
 */
export async function runPrivilegedOp(op: 'apply' | 'clean'): Promise<{ ok: boolean; code: number; cancelled?: boolean; error?: string }> {
  if (isRunning()) return { ok: false, code: -1, error: 'busy' }
  setRunning(true)
  setBusy(op)
  try {
    const conf = getSettings().confPath
    const useNopasswd = await isNopasswdActive()
    let ok: boolean
    let code: number
    let cancelled = false
    let error: string | undefined

    if (useNopasswd) {
      const outcome = await runScript(op, { mode: 'sudo-nopasswd', confPath: conf, onEvent: handleEvent })
      ok = outcome.code === 0
      code = outcome.code
      if (!ok) {
        // sudoers 条目未覆盖当前 conf（如切换到新 Profile 未重装授权）→ 失效缓存并给明确指引
        if (/password is required|not allowed to execute/i.test(outcome.stderr)) {
          invalidateNopasswd()
          error = '当前 Profile 不在免密授权白名单内（新增/切换配置后请在设置里重新安装授权），本次已回退'
          // 回退 osascript 一次，保证操作仍可完成
          const fallback = await runScriptPrivileged(op, { confPath: conf, onEvent: handleEvent })
          ok = fallback.code === 0
          code = fallback.code
          cancelled = fallback.cancelled
          error = fallback.error ?? error
        } else {
          error = outcome.stderr.trim().slice(0, 300) || `sudo 退出码 ${outcome.code}`
        }
      }
      console.log(`[vpnroute] ${op}(sudo-nopasswd) -> exit=${outcome.code}${error ? ` err=${error}` : ''}`)
    } else {
      const outcome = await runScriptPrivileged(op, { confPath: conf, onEvent: handleEvent })
      ok = outcome.code === 0
      code = outcome.code
      cancelled = outcome.cancelled
      error = outcome.error
      console.log(`[vpnroute] ${op}(osascript) -> exit=${outcome.code} cancelled=${outcome.cancelled}${error ? ` err=${error}` : ''}`)
    }

    // 成功后刷新路由视图 + 重置自动 Apply 冷却起点
    if (ok && op === 'apply') {
      noteManualApply()
      void refreshStatus()
    }
    return { ok, code, cancelled, error }
  } catch (err) {
    console.error(`[vpnroute] ${op}(privileged) failed:`, err)
    return { ok: false, code: -1, error: String(err) }
  } finally {
    setBusy(null)
    setRunning(false)
  }
}

export function refreshStatus(): Promise<{ ok: boolean; code: number; error?: string }> {
  return runReadonlyOp('status')
}

/** NOPASSWD 生效时注入自动 Apply 执行器（自动路径禁走 osascript：无人可输密码） */
export async function wireAutoApplier(): Promise<boolean> {
  const active = await isNopasswdActive()
  if (active) {
    setAutoApplier(async (conf) => {
      const out = await runScript('apply', { mode: 'sudo-nopasswd', confPath: conf, onEvent: handleEvent })
      return { ok: out.code === 0, code: out.code }
    })
  } else {
    setAutoApplier(null)
  }
  return active
}

export function registerIpc(): void {
  // phase 变化：tray 图标 + 面板推送（单处注册，避免回调覆盖）
  setPhaseListener((p) => {
    setTrayPhase(p)
    broadcast('evt:phase', p)
  })

  ipcMain.handle('op:status', () => runReadonlyOp('status'))
  ipcMain.handle('op:test', () => runReadonlyOp('test'))
  ipcMain.handle('op:apply', () => runPrivilegedOp('apply'))
  ipcMain.handle('op:clean', () => runPrivilegedOp('clean'))
  ipcMain.handle('state:snapshot', () => snapshot())

  ipcMain.handle('sudo:probe', () => isNopasswdActive(true))
  ipcMain.handle('sudo:install', async () => {
    const r = await installSudoers()
    if (r.ok) {
      invalidateNopasswd()
      resetScriptCache()
      void wireAutoApplier()
    }
    return r
  })
  ipcMain.handle('sudo:reinstall-script', async () => {
    const r = await reinstallScript()
    if (r.ok) resetScriptCache()
    return r
  })
  ipcMain.handle('sudo:uninstall', async (_e, alsoScript: boolean) => {
    const r = await uninstallSudoers(alsoScript)
    if (r.ok) {
      invalidateNopasswd()
      resetScriptCache()
      void wireAutoApplier()
    }
    return r
  })

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<AppSettings>) => {
    const r = saveSettings(patch).then(() => {
      restartPatrol() // 间隔/开关可能变化
      if (patch.theme) nativeTheme.themeSource = patch.theme // 深浅色即时生效
      return getSettings()
    })
    return r
  })

  ipcMain.handle('conf:load', () => loadConf())
  ipcMain.handle('conf:save', (_e, text: string, mtimeMs: number) => saveConf(text, mtimeMs))
  ipcMain.handle('conf:reload-status', () => refreshStatus())

  // 开机自启
  ipcMain.handle('app:get-open-at-login', () => app.getLoginItemSettings().openAtLogin)
  ipcMain.handle('app:set-open-at-login', (_e, enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enabled })
    return app.getLoginItemSettings().openAtLogin
  })

  // Profile 切换
  ipcMain.handle('profiles:list', () => listProfiles())
  ipcMain.handle('profiles:switch', async (_e, path: string) => {
    await saveSettings({ confPath: path })
    const r = await refreshStatus() // 立即按新配置重新探测
    return { ok: r.ok }
  })

  // 网络学习（扫描只读；确认后写回并刷新）
  ipcMain.handle('learn:scan', () => scanNetwork())
  ipcMain.handle('learn:apply', async (_e, selected: Parameters<typeof applyLearned>[0]) => {
    const r = await applyLearned(selected)
    if (r.ok) await refreshStatus()
    return r
  })
}
