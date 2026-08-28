// 菜单栏 Tray：按 phase 切换彩色图标
import { Tray, Menu, nativeImage, app } from 'electron'
import { join } from 'node:path'
import type { Phase } from '../shared/types'

let tray: Tray | null = null
let onPanelToggle: (() => void) | null = null

const ICON_FILES: Record<Phase, string> = {
  unknown: 'grey.png',
  checking: 'grey.png',
  busy: 'blue.png',
  ok: 'green.png',
  degraded: 'yellow.png',
  failed: 'red.png'
}

function iconPath(name: string): string {
  const base = app.isPackaged
    ? join(process.resourcesPath, 'icons')
    : join(__dirname, '../../resources/icons')
  return join(base, name)
}

export function createTray(onToggle: () => void): Tray {
  onPanelToggle = onToggle
  tray = new Tray(nativeImage.createFromPath(iconPath('grey.png')))
  tray.setToolTip('VPN Route')
  rebuildMenu()

  // macOS：左键点击切换面板；右键菜单由 rebuildMenu 提供
  tray.on('click', () => onPanelToggle?.())

  return tray
}

export function setTrayPhase(phase: Phase): void {
  if (!tray) return
  const img = nativeImage.createFromPath(iconPath(ICON_FILES[phase]))
  tray.setImage(img)
  tray.setToolTip(`VPN Route — ${phaseLabel(phase)}`)
}

function phaseLabel(p: Phase): string {
  const m: Record<Phase, string> = {
    unknown: '未检查',
    checking: '检查中…',
    busy: '操作进行中',
    ok: '全部正常',
    degraded: '部分异常',
    failed: '异常'
  }
  return m[p]
}

export function rebuildMenu(): void {
  if (!tray) return
  const menu = Menu.buildFromTemplate([
    { label: '显示面板', click: () => onPanelToggle?.() },
    {
      label: '编辑配置…',
      click: () => {
        void import('./editorWindow').then((m) => m.openEditorWindow())
      }
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ])
  tray.setContextMenu(menu)
}
