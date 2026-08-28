// 设置持久化：~/.vpn_route_bar/settings.json（零依赖自写，不引 electron-store）
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export type ThemeChoice = 'system' | 'dark' | 'light'

export interface AppSettings {
  /** VPN 全部就绪且路由失配时自动执行 apply */
  autoApplyEnabled: boolean
  /** 网络变化事件静默期（秒）：风暴期间零动作 */
  autoApplySettleSeconds: number
  /** 两次自动 apply 最小间隔（秒），网络持续震荡时防拉锯 */
  autoApplyCooldownSeconds: number
  /** 定时巡检（M6 接入 UI） */
  patrolEnabled: boolean
  patrolIntervalSeconds: number
  /** vpn_route.conf 路径（传给脚本 -c） */
  confPath: string
  /** 外观主题：跟随系统 / 深色 / 浅色 */
  theme: ThemeChoice
}

export const DEFAULT_SETTINGS: AppSettings = {
  autoApplyEnabled: true,
  autoApplySettleSeconds: 5,
  autoApplyCooldownSeconds: 120,
  patrolEnabled: true,
  patrolIntervalSeconds: 60,
  confPath: join(homedir(), '.vpn_route.conf'),
  theme: 'system'
}

const SETTINGS_FILE = join(homedir(), '.vpn_route_bar', 'settings.json')

let cache: AppSettings | null = null

export function getSettings(): AppSettings {
  return cache ?? DEFAULT_SETTINGS
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await readFile(SETTINGS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    cache = { ...DEFAULT_SETTINGS, ...parsed }
  } catch {
    cache = { ...DEFAULT_SETTINGS }
  }
  return cache
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = { ...getSettings(), ...patch }
  cache = next
  await mkdir(dirname(SETTINGS_FILE), { recursive: true })
  await writeFile(SETTINGS_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}
