// 网络监听：轻量轮询 utun 接口集合 + 默认路由接口，快照对比发变化事件
// （Electron 无法直接用 SCDynamicStore 事件；3s 轮询两个快速子进程开销可忽略，
//   配合 coordinator 的静默期防抖已足够）
import { execFile } from 'node:child_process'

export interface NetworkSnapshot {
  utuns: string[]
  defaultIface: string
}

function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

export async function takeSnapshot(): Promise<NetworkSnapshot> {
  const [ifList, routeOut] = await Promise.all([
    exec('/sbin/ifconfig', ['-l']),
    exec('/sbin/route', ['-n', 'get', 'default']).catch(() => '')
  ])
  const utuns = ifList
    .split(/\s+/)
    .filter((s) => s.startsWith('utun'))
    .sort()
  const m = routeOut.match(/interface:\s*(\S+)/)
  return { utuns, defaultIface: m ? m[1] : '' }
}

function sameSnapshot(a: NetworkSnapshot, b: NetworkSnapshot): boolean {
  return a.defaultIface === b.defaultIface && a.utuns.join(',') === b.utuns.join(',')
}

/**
 * 启动轮询监听。onChange 在快照与上一次不同时触发（首拍建立基线不触发）。
 * 返回停止函数。
 */
export function startNetWatcher(intervalMs: number, onChange: (snap: NetworkSnapshot) => void): () => void {
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  let prev: NetworkSnapshot | null = null

  const tick = async (): Promise<void> => {
    if (stopped) return
    try {
      const snap = await takeSnapshot()
      if (!prev) {
        console.log(`[vpnroute] net watcher baseline: utuns=[${snap.utuns.join(',')}] default=${snap.defaultIface}`)
      } else if (!sameSnapshot(prev, snap)) {
        onChange(snap)
      }
      prev = snap
    } catch {
      /* ifconfig/route 失败（瞬时）跳过本拍 */
    }
    if (!stopped) timer = setTimeout(tick, intervalMs)
  }
  void tick()

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
