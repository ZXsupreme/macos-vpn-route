// 网络学习向导：扫描在线 utun → 确认提案（可改名/勾选）→ 写回配置
import { useCallback, useState } from 'react'

interface LearnedVpn {
  name: string
  iface: string
  ipv4: string | null
  inet6: string | null
  detectInet6: string
  detectSubnet: string
  routeNets: string[]
  routeHosts: string[]
  matchedExisting: string | null
}

export default function LearnWizard({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [rows, setRows] = useState<LearnedVpn[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())

  const scan = useCallback(async (): Promise<void> => {
    setScanning(true)
    setResult(null)
    const learned = (await window.api.learnScan()) as LearnedVpn[]
    setRows(learned)
    setChecked(new Set(learned.map((l) => l.iface)))
    setScanning(false)
  }, [])

  const apply = useCallback(async (): Promise<void> => {
    if (!rows) return
    setSaving(true)
    const selected = rows
      .filter((r) => checked.has(r.iface))
      .map((r) => ({
        name: r.name || `vpn${rows.indexOf(r) + 1}`,
        iface: r.iface,
        detectInet6: r.detectInet6,
        detectSubnet: r.detectSubnet,
        routeNets: r.routeNets,
        routeHosts: r.routeHosts
      }))
    const r = await window.api.learnApply(selected)
    setSaving(false)
    setResult(
      r.ok
        ? `✅ 已写入 ${r.applied} 个 VPN${r.testsAdded > 0 ? `，新增 ${r.testsAdded} 条测试项` : ''}${r.createdConf ? '（新建了配置文件）' : ''}`
        : `❌ ${r.error ?? '写入失败'}`
    )
    if (r.ok) onDone()
  }, [rows, checked, onDone])

  return (
    <section className="card">
      <div className="card-title">网络学习</div>
      {!rows && (
        <div className="learn-intro">
          扫描当前在线的 VPN 接口，自动识别特征与路由网段并写入配置。使用前请先连上 VPN。
          <button className="primary" style={{ marginTop: 8, width: '100%' }} onClick={scan} disabled={scanning}>
            {scanning ? '扫描中…' : '学习当前网络'}
          </button>
        </div>
      )}
      {rows && (
        <>
          {rows.length === 0 && <div className="learn-intro">未发现任何在线 utun 接口——请先连接 VPN 再扫描。</div>}
          {rows.map((r, i) => (
            <div key={r.iface} className="learn-row">
              <label className="learn-check">
                <input
                  type="checkbox"
                  checked={checked.has(r.iface)}
                  onChange={(e) => {
                    const next = new Set(checked)
                    if (e.target.checked) next.add(r.iface)
                    else next.delete(r.iface)
                    setChecked(next)
                  }}
                />
              </label>
              <div className="learn-main">
                <div className="learn-head">
                  <input
                    className="learn-name"
                    value={r.name}
                    placeholder={`名称（vpn${i + 1}）`}
                    onChange={(e) => {
                      const next = [...rows]
                      next[i] = { ...r, name: e.target.value }
                      setRows(next)
                    }}
                  />
                  <span className="learn-iface">
                    {r.iface} · {r.ipv4 ?? '-'}
                    {r.inet6 ? ` · ${r.inet6}` : ''}
                  </span>
                </div>
                <div className="learn-detail">
                  识别: {r.detectInet6 || r.detectSubnet || '无特征'} · 路由: {r.routeNets.length} 网段 /{' '}
                  {r.routeHosts.length} 主机
                </div>
                {(r.routeNets.length > 0 || r.routeHosts.length > 0) && (
                  <div className="learn-nets">
                    {[...r.routeNets, ...r.routeHosts].join('、')}
                  </div>
                )}
                {r.routeNets.length === 0 && r.routeHosts.length === 0 && (
                  <div className="learn-nets warn">该接口没有被指向的网段路由（可能未配置分流或仅全局隧道）</div>
                )}
              </div>
            </div>
          ))}
          <div className="learn-actions">
            <button onClick={() => setRows(null)} disabled={saving}>
              重新扫描
            </button>
            <button className="primary" onClick={apply} disabled={saving || checked.size === 0}>
              {saving ? '写入中…' : `写入所选（${checked.size}）`}
            </button>
          </div>
        </>
      )}
      {result && <div className="learn-result">{result}</div>}
    </section>
  )
}
