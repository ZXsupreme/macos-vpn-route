// 下拉面板窗口：无边框、失焦隐藏、全工作区可见
import { BrowserWindow, screen, shell, nativeTheme } from 'electron'
import { join } from 'node:path'

export const PANEL_SIZE = { width: 420, height: 620 }

let panel: BrowserWindow | null = null
/** show 后短暂忽略 blur（显示瞬间焦点未稳会被立即隐藏，看起来像"没弹出"） */
let blurGuardUntil = 0

export function createPanel(): BrowserWindow {
  panel = new BrowserWindow({
    width: PANEL_SIZE.width,
    height: PANEL_SIZE.height,
    show: false,
    frame: false,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // 不依赖系统毛玻璃（部分系统版本回落为白底导致文字不可读），用确定性底色并随主题切换
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181d' : '#eef0f4',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true
    }
  })

  panel.on('blur', () => {
    if (Date.now() < blurGuardUntil) return
    hidePanel()
  })
  panel.on('closed', () => {
    panel = null
  })

  // 外链走系统浏览器
  panel.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // dev 阶段由 electron-vite 注入 ELECTRON_RENDERER_URL
  if (process.env.ELECTRON_RENDERER_URL) {
    void panel.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void panel.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return panel
}

export function getPanel(): BrowserWindow | null {
  return panel
}

let lastToggleAt = 0

export function togglePanel(trayBounds?: Electron.Rectangle): void {
  if (!panel) return
  // 连续快速点击（双击习惯）只触发一次开关，避免"弹出又立刻收起"
  const now = Date.now()
  if (now - lastToggleAt < 300) return
  lastToggleAt = now

  if (panel.isVisible()) {
    panel.hide()
    return
  }
  positionPanel(trayBounds)
  blurGuardUntil = now + 400
  panel.show()
  panel.focus()
}

export function hidePanel(): void {
  panel?.hide()
}

/** 面板定位：菜单栏图标正下方，屏幕右上限内 */
function positionPanel(trayBounds?: Electron.Rectangle): void {
  if (!panel) return
  const display = screen.getPrimaryDisplay()
  const work = display.workArea

  let x: number
  if (trayBounds) {
    x = Math.round(trayBounds.x + trayBounds.width / 2 - PANEL_SIZE.width / 2)
  } else {
    x = work.x + work.width - PANEL_SIZE.width - 12
  }
  x = Math.max(work.x, Math.min(x, work.x + work.width - PANEL_SIZE.width))
  const y = trayBounds ? trayBounds.y + trayBounds.height + 6 : work.y + 8

  panel.setPosition(x, y, false)
}
