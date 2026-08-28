// 网络学习解析（纯函数，无 Electron/Node 依赖，主进程与测试脚本共用）
// 从 ifconfig -a 识别在线 utun 的地址特征，从 netstat -rn 反推各接口被指向的网段

export interface IfaceInfo {
  iface: string
  ipv4: string | null
  inet6: string | null
}

export interface RouteRow {
  dest: string
  netif: string
}

/** 解析 ifconfig -a：取每个 utun 的首个 IPv4 与首个非 fe80 IPv6 */
export function parseIfconfig(out: string): IfaceInfo[] {
  const result: IfaceInfo[] = []
  let cur: IfaceInfo | null = null
  for (const line of out.split('\n')) {
    const head = line.match(/^(utun\d+):/)
    if (head) {
      if (cur) result.push(cur)
      cur = { iface: head[1], ipv4: null, inet6: null }
      continue
    }
    if (!cur) continue
    const t = line.trim()
    const v4 = t.match(/^inet (\d+\.\d+\.\d+\.\d+)/)
    if (v4 && !cur.ipv4) cur.ipv4 = v4[1]
    const v6 = t.match(/^inet6 ([0-9a-f:]+)/)
    if (v6 && !cur.inet6 && !v6[1].startsWith('fe80')) cur.inet6 = v6[1]
  }
  if (cur) result.push(cur)
  return result
}

/** IPv6 地址取识别前缀：前 3 段（如 fd00:abcd:1234），与脚本 detect 的 grep 语义对齐 */
export function inet6Prefix(addr: string): string {
  const head = addr.split('::')[0] ?? ''
  const parts = head.split(':').filter(Boolean)
  return parts.slice(0, 3).join(':')
}

/** IPv4 取识别前缀：前 2 段（如 10.51） */
export function subnetPrefix(ip: string): string {
  return ip.split('.').slice(0, 2).join('.')
}

const IFACE_RE = /^(utun|en|lo|bridge|awdl|llw|vlan|gif|stf|ap|fa)\d+$/

/** 补全 netstat 的缩写网段: "10.20.0/24" -> "10.20.0.0/24"；无 "/" 视为主机 */
export function normalizeDest(dest: string): { kind: 'net' | 'host'; value: string } | null {
  if (!dest.includes('/')) {
    return /^\d+\.\d+\.\d+\.\d+$/.test(dest) ? { kind: 'host', value: dest } : null
  }
  const [ip, maskRaw] = dest.split('/')
  const parts = ip.split('.')
  if (parts.length > 4) return null
  while (parts.length < 4) parts.push('0')
  const padded = parts.join('.')
  const mask = Number(maskRaw)
  if (!Number.isInteger(mask) || mask < 0 || mask > 32) return null
  return { kind: 'net', value: `${padded}/${mask}` }
}

export function skipDest(ip: string): boolean {
  return (
    ip.startsWith('127.') ||
    ip.startsWith('169.254.') ||
    ip.startsWith('224.') ||
    ip.startsWith('239.') ||
    ip.startsWith('255.') ||
    ip === '0.0.0.0'
  )
}

/** 解析 netstat -rn -f inet：取 Destination 与 Netif（从行尾找接口名，Expire 列可能为空） */
export function parseNetstat(out: string): RouteRow[] {
  const rows: RouteRow[] = []
  for (const line of out.split('\n')) {
    if (line.startsWith('default')) continue // default 永远归还 Wi-Fi，不学习
    const cols = line.trim().split(/\s+/)
    if (cols.length < 3) continue
    let netif = ''
    for (let i = cols.length - 1; i >= Math.max(1, cols.length - 4); i--) {
      if (IFACE_RE.test(cols[i])) {
        netif = cols[i]
        break
      }
    }
    if (netif) rows.push({ dest: cols[0], netif })
  }
  return rows
}
