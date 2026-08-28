// 网络学习器：扫描当前在线的 utun 接口，从实时路由表反推每个 VPN 的势力范围，
// 生成可写回 conf 的学习提案。纯只读，零副作用；确认与写回由 ipc.learnApply 完成。
// 解析纯函数在 shared/learnParse（与测试脚本共用）。
import { execFile } from 'node:child_process'
import type { ConfElement, ConfModel, VpnEntry } from '../shared/confFormat'
import { parseConf, toModel, applyModel, renderConf } from '../shared/confFormat'
import {
  parseIfconfig,
  parseNetstat,
  normalizeDest,
  skipDest,
  inet6Prefix,
  subnetPrefix
} from '../shared/learnParse'
import { loadConf, saveConf } from './configStore'

export interface LearnedVpn {
  name: string // 提案名（命中既有配置时沿用其名）
  iface: string
  ipv4: string | null
  inet6: string | null
  detectInet6: string // 由 IPv6 地址生成的前缀（前 3 段）
  detectSubnet: string // 由 IPv4 地址生成的前缀（前 2 段）
  routeNets: string[] // 指向该 utun 的网段路由（CIDR）
  routeHosts: string[] // 指向该 utun 的主机路由（裸 IP，来自 /32）
  matchedExisting: string | null
}

function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 8000, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

/** 扫描当前网络：在线 utun + 各自被指向的网段/主机路由 */
export async function scanNetwork(): Promise<LearnedVpn[]> {
  const [ifOut, nsOut] = await Promise.all([
    exec('/sbin/ifconfig', ['-a']),
    exec('/usr/sbin/netstat', ['-rn', '-f', 'inet']).catch(() => '')
  ])
  const ifaces = parseIfconfig(ifOut).filter((i) => i.ipv4 || i.inet6)
  const routes = parseNetstat(nsOut)

  return ifaces.map((it) => {
    const nets = new Set<string>()
    const hosts = new Set<string>()
    for (const r of routes) {
      if (r.netif !== it.iface) continue
      const n = normalizeDest(r.dest)
      if (!n || skipDest(n.value.split('/')[0])) continue
      // 排除隧道自身地址（utun 自己的 /32 不是"势力范围"）
      if (n.kind === 'host' && n.value === it.ipv4) continue
      if (n.kind === 'net') nets.add(n.value)
      else hosts.add(n.value)
    }
    return {
      name: '',
      iface: it.iface,
      ipv4: it.ipv4,
      inet6: it.inet6,
      detectInet6: it.inet6 ? inet6Prefix(it.inet6) : '',
      detectSubnet: it.ipv4 ? subnetPrefix(it.ipv4) : '',
      routeNets: [...nets].sort(),
      routeHosts: [...hosts].sort(),
      matchedExisting: null
    }
  })
}

/** 与既有配置匹配：名字 / 识别特征 / 路由集合重叠，命中则沿用其名与位置 */
function matchExisting(v: LearnedVpn, model: ConfModel): VpnEntry | undefined {
  return model.vpns.find(
    (e) =>
      (v.detectSubnet !== '' && e.detectSubnet === v.detectSubnet) ||
      (v.detectInet6 !== '' && e.detectInet6 === v.detectInet6) ||
      v.routeNets.some((n) => e.routeNets.includes(n))
  )
}

export interface LearnApplyResult {
  ok: boolean
  error?: string
  createdConf: boolean
  applied: number
  testsAdded: number
}

/**
 * 把确认过的学习提案合并进配置（存在则更新，新增则追加）并写回。
 * 配置文件不存在时从零创建（新用户首次使用路径）。
 */
export async function applyLearned(
  selected: Array<Pick<LearnedVpn, 'name' | 'iface' | 'detectInet6' | 'detectSubnet' | 'routeNets' | 'routeHosts'>>
): Promise<LearnApplyResult> {
  if (selected.length === 0) return { ok: false, error: '未选择任何条目', createdConf: false, applied: 0, testsAdded: 0 }

  let elements: ConfElement[]
  let createdConf = false
  try {
    elements = parseConf((await loadConf()).text)
  } catch {
    elements = parseConf('# 由 VPNRouteBar 网络学习生成\n')
    createdConf = true
  }
  const model = toModel(elements)
  const usedNames = new Set(model.vpns.map((v) => v.name))
  const newVpns: Array<{ name: string; routeHosts: string[] }> = []

  for (const sel of selected) {
    if (!/^[a-z][a-z0-9_]*$/.test(sel.name)) {
      return { ok: false, error: `VPN 名须为小写字母/数字: ${sel.name}`, createdConf, applied: 0, testsAdded: 0 }
    }
    const hit = matchExisting({ ...sel } as LearnedVpn, model)
    if (hit) {
      hit.name = sel.name
      if (sel.detectInet6) hit.detectInet6 = sel.detectInet6
      if (sel.detectSubnet) hit.detectSubnet = sel.detectSubnet
      hit.routeNets = sel.routeNets
      hit.routeHosts = sel.routeHosts
    } else {
      // 重名防御
      let name = sel.name
      let i = 2
      while (usedNames.has(name)) name = `${sel.name}${i++}`
      usedNames.add(name)
      model.vpns.push({
        name,
        detectInet6: sel.detectInet6,
        detectSubnet: sel.detectSubnet,
        routeNets: sel.routeNets,
        routeHosts: sel.routeHosts
      })
      newVpns.push({ name, routeHosts: sel.routeHosts })
    }
  }

  // 测试项提案：新用户的配置从零生成时补公网基线 + 每个新学到的 VPN 一条内网探测。
  // 已有配置的 VPN 不动其测试项（用户自己维护）。
  const isPrivate = (ip: string): boolean =>
    ip.startsWith('10.') || ip.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  let testsAdded = 0
  if (createdConf) {
    if (!model.tests.some((t) => t.kind === 'public')) {
      model.tests.unshift({ desc: '公网访问', target: 'www.baidu.com', kind: 'public', port: '0' })
      testsAdded++
    }
  }
  for (const nv of newVpns) {
    if (model.tests.some((t) => t.desc === `${nv.name} 连通`)) continue
    const candidate = nv.routeHosts.find(isPrivate) ?? nv.routeHosts[0]
    if (candidate) {
      model.tests.push({ desc: `${nv.name} 连通`, target: candidate, kind: 'tcp', port: '443' })
      testsAdded++
    }
  }

  // 从零创建时补最小骨架（applyModel 会写全部字段）
  const next = applyModel(elements, model)
  const r = await saveConf(renderConf(next)) // 新文件/外部无改动时 mtime 检查跳过
  return { ok: r.ok, error: r.error, createdConf, applied: selected.length, testsAdded }
}
