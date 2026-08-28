// contextBridge 暴露类型化 API：renderer 无直接 Node 能力
import { contextBridge, ipcRenderer } from 'electron'
import type { Phase, ScriptEvent } from '../shared/types'

const api = {
  // 操作（invoke 返回执行结果；过程事件走 onScriptEvent）
  status: (): Promise<{ ok: boolean; code: number; error?: string }> => ipcRenderer.invoke('op:status'),
  test: (): Promise<{ ok: boolean; code: number; error?: string }> => ipcRenderer.invoke('op:test'),
  apply: (): Promise<{ ok: boolean; code: number; cancelled?: boolean; error?: string }> =>
    ipcRenderer.invoke('op:apply'),
  clean: (): Promise<{ ok: boolean; code: number; cancelled?: boolean; error?: string }> =>
    ipcRenderer.invoke('op:clean'),
  snapshot: (): Promise<unknown> => ipcRenderer.invoke('state:snapshot'),

  // sudoers 免密授权管理
  sudoProbe: (): Promise<boolean> => ipcRenderer.invoke('sudo:probe'),
  sudoInstall: (): Promise<{ ok: boolean; cancelled?: boolean; error?: string }> =>
    ipcRenderer.invoke('sudo:install'),
  sudoReinstallScript: (): Promise<{ ok: boolean; cancelled?: boolean; error?: string }> =>
    ipcRenderer.invoke('sudo:reinstall-script'),
  sudoUninstall: (alsoScript: boolean): Promise<{ ok: boolean; cancelled?: boolean; error?: string }> =>
    ipcRenderer.invoke('sudo:uninstall', alsoScript),

  // 设置
  settingsGet: (): Promise<unknown> => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch: Record<string, unknown>): Promise<unknown> => ipcRenderer.invoke('settings:set', patch),

  // 配置编辑器
  confLoad: (): Promise<{ text: string; mtimeMs: number }> => ipcRenderer.invoke('conf:load'),
  confSave: (text: string, mtimeMs: number): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('conf:save', text, mtimeMs),
  confReloadStatus: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('conf:reload-status'),

  // 开机自启
  getOpenAtLogin: (): Promise<boolean> => ipcRenderer.invoke('app:get-open-at-login'),
  setOpenAtLogin: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('app:set-open-at-login', enabled),

  // Profile 切换
  profilesList: (): Promise<{ name: string; path: string; active: boolean }[]> =>
    ipcRenderer.invoke('profiles:list'),
  profilesSwitch: (path: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('profiles:switch', path),

  // 网络学习
  learnScan: (): Promise<unknown> => ipcRenderer.invoke('learn:scan'),
  learnApply: (
    selected: Array<{ name: string; iface: string; detectInet6: string; detectSubnet: string; routeNets: string[]; routeHosts: string[] }>
  ): Promise<{ ok: boolean; error?: string; createdConf: boolean; applied: number; testsAdded: number }> =>
    ipcRenderer.invoke('learn:apply', selected),

  // 事件订阅（返回取消函数）
  onScriptEvent: (cb: (ev: ScriptEvent) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: ScriptEvent): void => cb(ev)
    ipcRenderer.on('evt:script', listener)
    return () => ipcRenderer.removeListener('evt:script', listener)
  },
  onPhase: (cb: (p: Phase) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, p: Phase): void => cb(p)
    ipcRenderer.on('evt:phase', listener)
    return () => ipcRenderer.removeListener('evt:phase', listener)
  }
}

export type RendererApi = typeof api
contextBridge.exposeInMainWorld('api', api)
