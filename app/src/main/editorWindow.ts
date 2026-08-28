// 配置编辑器独立窗口（面板太窄，编辑器需要正常窗口尺寸）
import { BrowserWindow, shell, nativeTheme } from 'electron'
import { join } from 'node:path'

let win: BrowserWindow | null = null

export function openEditorWindow(): void {
  if (win && !win.isDestroyed()) {
    win.show()
    win.focus()
    return
  }
  win = new BrowserWindow({
    width: 760,
    height: 720,
    title: 'VPN Route 配置编辑器',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1d23' : '#f5f5f7',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true
    }
  })
  win.on('closed', () => {
    win = null
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    // dev：带 hash 路由到编辑器视图
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/editor`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'editor' })
  }
}
