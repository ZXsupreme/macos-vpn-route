// vpn_route.conf（bash 语法）的保序解析 / 手术式更新 / 渲染。
// 纯函数无 IO，主进程（预检）与渲染进程（编辑器）共用。
// 原则：未编辑的行逐字保留（注释、空行、分区习惯全不动）；解析不了的行标记 unknown 原样回写。

export type ConfElement =
  | { kind: 'blank' }
  | { kind: 'comment'; text: string } // 原字面整行
  | { kind: 'assign'; name: string; value: string } // 单值（渲染恒带双引号）
  | { kind: 'array'; name: string; items: string[]; block: boolean } // 数组（block=多行块状）
  | { kind: 'unknown'; text: string } // 复杂语法：原样保留永不改写

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 从一行数组体提取双引号串（引号感知；值内可含 | 与空格） */
function extractQuoted(text: string): string[] {
  const items: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    items.push(m[1].replace(/\\(.)/g, '$1'))
  }
  return items
}

export function parseConf(text: string): ConfElement[] {
  const lines = text.split('\n')
  const elements: ConfElement[] = []
  let i = 0
  while (i < lines.length) {
    const raw = lines[i]
    const t = raw.trim()
    if (t === '') {
      elements.push({ kind: 'blank' })
      i++
      continue
    }
    if (t.startsWith('#')) {
      elements.push({ kind: 'comment', text: raw })
      i++
      continue
    }
    // 单行数组 NAME=("a" "b")
    const arr1 = t.match(/^([A-Za-z_][A-Za-z0-9_]*)=\((.*)\)\s*$/)
    if (arr1) {
      elements.push({ kind: 'array', name: arr1[1], items: extractQuoted(arr1[2]), block: false })
      i++
      continue
    }
    // 多行块数组 NAME=( ... )
    const arrOpen = t.match(/^([A-Za-z_][A-Za-z0-9_]*)=\(\s*$/)
    if (arrOpen) {
      const items: string[] = []
      i++
      while (i < lines.length && lines[i].trim() !== ')') {
        items.push(...extractQuoted(lines[i]))
        i++
      }
      if (i < lines.length) i++ // 消费 ')' 行
      elements.push({ kind: 'array', name: arrOpen[1], items, block: true })
      continue
    }
    // 单值 NAME="v" / NAME=v
    const asg = t.match(/^([A-Za-z_][A-Za-z0-9_]*)=("((?:[^"\\]|\\.)*)"|[^\s#]*)\s*$/)
    if (asg) {
      const v = asg[3] !== undefined ? asg[3].replace(/\\(.)/g, '$1') : asg[2]
      elements.push({ kind: 'assign', name: asg[1], value: v })
      i++
      continue
    }
    elements.push({ kind: 'unknown', text: raw })
    i++
  }
  return elements
}

function quote(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function renderConf(elements: ConfElement[]): string {
  const out: string[] = []
  for (const el of elements) {
    switch (el.kind) {
      case 'blank':
        out.push('')
        break
      case 'comment':
      case 'unknown':
        out.push(el.text)
        break
      case 'assign':
        out.push(`${el.name}=${quote(el.value)}`)
        break
      case 'array':
        if (el.block) {
          out.push(`${el.name}=(`)
          for (const it of el.items) out.push(`    ${quote(it)}`)
          out.push(')')
        } else {
          out.push(`${el.name}=(${el.items.map(quote).join(' ')})`)
        }
        break
    }
  }
  // 文件以单个换行结尾
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return `${out.join('\n')}\n`
}

// ---------- 结构化视图与手术式更新 ----------

export function getScalar(elements: ConfElement[], name: string): string | undefined {
  for (const el of elements) if (el.kind === 'assign' && el.name === name) return el.value
  return undefined
}

export function getArray(elements: ConfElement[], name: string): string[] | undefined {
  for (const el of elements) if (el.kind === 'array' && el.name === name) return [...el.items]
  return undefined
}

/** 更新（存在则原位替换，不存在则 append）；返回新数组 */
export function setScalar(elements: ConfElement[], name: string, value: string): ConfElement[] {
  if (!NAME_RE.test(name)) throw new Error(`非法变量名: ${name}`)
  let replaced = false
  const next = elements.map((el) => {
    if (el.kind === 'assign' && el.name === name) {
      replaced = true
      return { kind: 'assign', name, value } as ConfElement
    }
    return el
  })
  if (!replaced) next.push({ kind: 'assign', name, value })
  return next
}

export function setArray(elements: ConfElement[], name: string, items: string[], block = false): ConfElement[] {
  if (!NAME_RE.test(name)) throw new Error(`非法变量名: ${name}`)
  let replaced = false
  const next = elements.map((el) => {
    if (el.kind === 'array' && el.name === name) {
      replaced = true
      return { kind: 'array', name, items: [...items], block: el.block || block } as ConfElement
    }
    return el
  })
  if (!replaced) next.push({ kind: 'array', name, items: [...items], block })
  return next
}

// ---------- 领域模型 ----------

export const VPN_NAME_RE = /^[a-z][a-z0-9_]*$/

export function upperName(name: string): string {
  return name.toUpperCase() // 与脚本 tr '[:lower:]' '[:upper:]' 对齐（ASCII 名）
}

export interface VpnEntry {
  name: string
  detectInet6: string
  detectSubnet: string
  routeNets: string[]
  routeHosts: string[]
}

export interface ConfModel {
  wifiService: string
  dnsServers: string[]
  cleanupNets: string[]
  cleanupHosts: string[]
  vpns: VpnEntry[]
  tests: { desc: string; target: string; kind: string; port: string }[]
}

export function toModel(elements: ConfElement[]): ConfModel {
  const names = getArray(elements, 'VPN_NAMES') ?? []
  const vpns: VpnEntry[] = names.map((n) => ({
    name: n,
    detectInet6: getScalar(elements, `${upperName(n)}_DETECT_INET6`) ?? '',
    detectSubnet: getScalar(elements, `${upperName(n)}_DETECT_SUBNET`) ?? '',
    routeNets: getArray(elements, `${upperName(n)}_ROUTE_NETS`) ?? [],
    routeHosts: getArray(elements, `${upperName(n)}_ROUTE_HOSTS`) ?? []
  }))
  const tests = (getArray(elements, 'TESTS') ?? []).map((t) => {
    const [desc = '', target = '', kind = '', port = ''] = t.split('|')
    return { desc, target, kind, port }
  })
  return {
    wifiService: getScalar(elements, 'WIFI_SERVICE') ?? 'Wi-Fi',
    dnsServers: getArray(elements, 'DNS_SERVERS') ?? [],
    cleanupNets: getArray(elements, 'CLEANUP_NETS') ?? [],
    cleanupHosts: getArray(elements, 'CLEANUP_HOSTS') ?? [],
    vpns,
    tests
  }
}

/** 把领域模型写回元素流（手术式：只动涉及的 assignment；新增 VPN 追加到尾部） */
export function applyModel(elements: ConfElement[], model: ConfModel): ConfElement[] {
  let next = [...elements]
  for (const v of model.vpns) {
    if (!VPN_NAME_RE.test(v.name)) throw new Error(`非法 VPN 名: ${v.name}（须匹配 ^[a-z][a-z0-9_]*$）`)
  }
  next = setScalar(next, 'WIFI_SERVICE', model.wifiService)
  next = setArray(next, 'DNS_SERVERS', model.dnsServers)
  next = setArray(next, 'CLEANUP_NETS', model.cleanupNets)
  next = setArray(next, 'CLEANUP_HOSTS', model.cleanupHosts)
  next = setArray(next, 'VPN_NAMES', model.vpns.map((v) => v.name))
  for (const v of model.vpns) {
    const U = upperName(v.name)
    next = setScalar(next, `${U}_DETECT_INET6`, v.detectInet6)
    next = setScalar(next, `${U}_DETECT_SUBNET`, v.detectSubnet)
    next = setArray(next, `${U}_ROUTE_NETS`, v.routeNets)
    next = setArray(next, `${U}_ROUTE_HOSTS`, v.routeHosts)
  }
  next = setArray(
    next,
    'TESTS',
    model.tests.map((t) => `${t.desc}|${t.target}|${t.kind}|${t.port}`),
    true
  )
  return next
}
