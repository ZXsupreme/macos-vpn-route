// 应用入口：单实例锁 + Tray + 面板 + 网络监听
import { app, BrowserWindow, globalShortcut, nativeTheme } from 'electron'
import { createPanel, togglePanel, getPanel } from './panel'
import { createTray } from './tray'
import { registerIpc, refreshStatus, wireAutoApplier } from './ipc'
import { loadSettings, getSettings } from './settings'
import { startNetWatcher } from './netWatcher'
import { startPatrol } from './patrol'
import { handleNetworkChange, setAutoEventListener } from './autoApply'
import { ingestEvent } from './appState'

// 单实例锁：防双图标双 apply 竞争
console.log('[boot] requesting single-instance lock...')
const gotLock = app.requestSingleInstanceLock()
console.log(`[boot] lock=${gotLock}`)
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // 已在运行：唤起面板
    togglePanel()
  })

  void app.whenReady().then(main)
}

async function main(): Promise<void> {
  console.log('[boot] main start')
  // 菜单栏应用：隐藏 Dock 图标（打包版另有 Info.plist LSUIElement，此处覆盖 dev 裸进程）
  app.dock?.hide()
  await loadSettings()
  nativeTheme.themeSource = getSettings().theme // 深浅色主题（跟随系统/深/浅）
  registerIpc()

  createPanel()
  console.log('[boot] panel created')
  const tray = createTray(() => togglePanel(tray.getBounds()))

  // 自动 Apply 决策事件 → 面板事件流水（applier 在 M5 注入）
  setAutoEventListener((ev) => {
    ingestEvent(ev)
    const win = getPanel()
    if (win && !win.isDestroyed()) win.webContents.send('evt:script', ev)
  })

  // 网络监听：3s 轮询 utun 集合 + 默认路由，变化 → 防抖评估
  startNetWatcher(3000, (snap) => {
    console.log(`[vpnroute] net change: utuns=[${snap.utuns.join(',')}] default=${snap.defaultIface}`)
    handleNetworkChange()
  })

  // sudoers NOPASSWD 自检：生效则激活自动 Apply（否则自动路径禁用，面板显示安装引导）
  const nopasswd = await wireAutoApplier()
  console.log(`[boot] nopasswd=${nopasswd}`)

  // 定时巡检（status + test + 失败变化沿通知）
  startPatrol()

  // 全局快捷键呼出面板（菜单栏图标被刘海遮挡/收纳时仍可用）
  const shortcut = globalShortcut.register('Alt+Cmd+V', () => {
    togglePanel()
  })
  console.log(`[boot] shortcut(⌥⌘V)=${shortcut}`)

  // 首次自动拉取状态（status 无 sudo；面板未加载完时 broadcast 无害）
  void refreshStatus()

  app.on('window-all-closed', () => {
    // 菜单栏常驻：面板只 hide 不销毁，不退出应用
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createPanel()
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
  })

  console.log(`[boot] ready (autoApply=${getSettings().autoApplyEnabled})`)
}
