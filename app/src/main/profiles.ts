// 配置 Profile：约定优于配置——扫描 ~ 下 vpn_route*.conf / .vpn_route*.conf 即为一个环境
// 新增环境 = cp 一份新 conf 文件，面板切换器自动出现
import { readdir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { getSettings } from './settings'

export interface Profile {
  name: string
  path: string
  active: boolean
}

function displayName(file: string): string {
  if (file === '.vpn_route.conf' || file === 'vpn_route.conf') return '默认'
  return file.replace(/^\.?vpn_route_?/, '').replace(/\.conf$/, '') || file
}

/** 列出所有 Profile（当前 confPath 标记 active）。排除备份与临时文件 */
export async function listProfiles(): Promise<Profile[]> {
  const home = homedir()
  let files: string[] = []
  try {
    files = await readdir(home)
  } catch {
    return []
  }
  const confs = files.filter(
    (f) => /^\.?vpn_route[\w.-]*\.conf$/.test(f) && !f.includes('.bak') && !f.includes('.tmp') && !f.includes('.bad')
  )
  const current = getSettings().confPath
  return confs
    .map((f) => {
      const path = join(home, f)
      return { name: displayName(f), path, active: path === current }
    })
    .sort((a, b) => (a.active ? -1 : b.active ? 1 : a.name.localeCompare(b.name)))
}

/** sudoers 安装用的全部 conf 路径（含当前 settings 指向的自定义路径，可能不在 ~ 下） */
export async function allConfPaths(): Promise<string[]> {
  const paths = (await listProfiles()).map((p) => p.path)
  const cur = getSettings().confPath
  if (!paths.includes(cur)) paths.push(cur)
  return paths
}
