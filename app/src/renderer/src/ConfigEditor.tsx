// 配置编辑器：表单模式（结构化）+ 原始文本模式双模式，保存走统一预检管线
// （bash -n 语法 + status --json 语义校验 + 备份 + 原子替换，均在主进程完成）
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ConfModel, VpnEntry } from '@shared/confFormat'
import { parseConf, renderConf, toModel, applyModel, type ConfElement } from '@shared/confFormat'

const EMPTY_VPN: VpnEntry = { name: '', detectInet6: '', detectSubnet: '', routeNets: [], routeHosts: [] }

export default function ConfigEditor(): React.JSX.Element {
  const [elements, setElements] = useState<ConfElement[]>([])
  const [model, setModel] = useState<ConfModel | null>(null)
  const [mtimeMs, setMtimeMs] = useState(0)
  const [mode, setMode] = useState<'form' | 'raw'>('form')
  const [rawText, setRawText] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void window.api.confLoad().then(({ text, mtimeMs: m }) => {
      const els = parseConf(text)
      setElements(els)
      setModel(toModel(els))
      setRawText(text)
      setMtimeMs(m)
    })
  }, [])

  // 表单 → 元素流 → 文本（手术式：未编辑的注释/空行/未知行原样保留）
  const serialized = useMemo(() => {
    if (!model) return ''
    try {
      return renderConf(applyModel(elements, model))
    } catch (e) {
      return `⚠️ ${String(e)}`
    }
  }, [elements, model])

  const save = useCallback(async (): Promise<void> => {
    setSaving(true)
    setError('')
    setSaved(false)
    const text = mode === 'form' ? serialized : rawText
    const r = await window.api.confSave(text, mtimeMs)
    setSaving(false)
    if (r.ok) {
      setSaved(true)
      // 重新加载（拿到新 mtime）+ 刷新主面板状态
      void window.api.confLoad().then(({ text: t, mtimeMs: m }) => {
        const els = parseConf(t)
        setElements(els)
        setModel(toModel(els))
        setRawText(t)
        setMtimeMs(m)
      })
      void window.api.confReloadStatus()
    } else {
      setError(r.error ?? '保存失败')
    }
  }, [mode, serialized, rawText, mtimeMs])

  if (!model) return <div className="editor">加载中…</div>

  return (
    <div className="editor">
      <header className="ed-header">
        <h1>VPN Route 配置</h1>
        <div className="ed-actions">
          <button
            onClick={() => {
              if (mode === 'form') {
                setRawText(serialized) // 以当前表单序列化结果为原始模式起点
                setMode('raw')
              } else {
                setMode('form')
              }
            }}
          >
            {mode === 'form' ? '原始文本' : '表单'}
          </button>
          <button className="primary" onClick={save} disabled={saving}>
            {saving ? '校验中…' : '保存'}
          </button>
        </div>
      </header>

      {error && <div className="ed-error">❌ {error}</div>}
      {saved && <div className="ed-ok">✅ 已保存（旧文件已备份）</div>}

      {mode === 'form' ? (
        <div className="ed-body">
          <section className="ed-card">
            <h2>通用</h2>
            <label>
              物理网络服务名 (WIFI_SERVICE)
              <input value={model.wifiService} onChange={(e) => setModel({ ...model, wifiService: e.target.value })} />
            </label>
            <label>
              DNS 服务器（每行一个，公网在前）
              <textarea
                rows={3}
                value={model.dnsServers.join('\n')}
                onChange={(e) => setModel({ ...model, dnsServers: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })}
              />
            </label>
            <label>
              清理网段 CLEANUP_NETS（每行一个 CIDR）
              <textarea
                rows={3}
                value={model.cleanupNets.join('\n')}
                onChange={(e) => setModel({ ...model, cleanupNets: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })}
              />
            </label>
            <label>
              清理主机 CLEANUP_HOSTS（每行一个 IP）
              <textarea
                rows={3}
                value={model.cleanupHosts.join('\n')}
                onChange={(e) => setModel({ ...model, cleanupHosts: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })}
              />
            </label>
          </section>

          <section className="ed-card">
            <h2>VPN 列表</h2>
            {model.vpns.map((v, i) => (
              <div key={i} className="ed-vpn">
                <div className="ed-vpn-head">
                  <input
                    className="ed-name"
                    value={v.name}
                    placeholder="名称（小写）"
                    onChange={(e) => {
                      const vpns = [...model.vpns]
                      vpns[i] = { ...v, name: e.target.value }
                      setModel({ ...model, vpns })
                    }}
                  />
                  <button
                    className="danger"
                    onClick={() => setModel({ ...model, vpns: model.vpns.filter((_, j) => j !== i) })}
                  >
                    删除
                  </button>
                </div>
                <div className="ed-grid">
                  <label>
                    DETECT_INET6 前缀
                    <input
                      value={v.detectInet6}
                      placeholder="如 fd00:abcd:1234"
                      onChange={(e) => {
                        const vpns = [...model.vpns]
                        vpns[i] = { ...v, detectInet6: e.target.value.trim() }
                        setModel({ ...model, vpns })
                      }}
                    />
                  </label>
                  <label>
                    DETECT_SUBNET 前缀
                    <input
                      value={v.detectSubnet}
                      placeholder="如 10.51"
                      onChange={(e) => {
                        const vpns = [...model.vpns]
                        vpns[i] = { ...v, detectSubnet: e.target.value.trim() }
                        setModel({ ...model, vpns })
                      }}
                    />
                  </label>
                  <label>
                    路由网段（每行一个 CIDR）
                    <textarea
                      rows={2}
                      value={v.routeNets.join('\n')}
                      onChange={(e) => {
                        const vpns = [...model.vpns]
                        vpns[i] = { ...v, routeNets: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) }
                        setModel({ ...model, vpns })
                      }}
                    />
                  </label>
                  <label>
                    路由主机（每行一个 IP）
                    <textarea
                      rows={2}
                      value={v.routeHosts.join('\n')}
                      onChange={(e) => {
                        const vpns = [...model.vpns]
                        vpns[i] = { ...v, routeHosts: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) }
                        setModel({ ...model, vpns })
                      }}
                    />
                  </label>
                </div>
              </div>
            ))}
            <button onClick={() => setModel({ ...model, vpns: [...model.vpns, { ...EMPTY_VPN }] })}>
              + 新增 VPN
            </button>
          </section>

          <section className="ed-card">
            <h2>连通性测试</h2>
            <table className="ed-tests">
              <thead>
                <tr>
                  <th>描述</th>
                  <th>目标</th>
                  <th>类型</th>
                  <th>端口</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {model.tests.map((t, i) => (
                  <tr key={i}>
                    <td>
                      <input
                        value={t.desc}
                        onChange={(e) => {
                          const tests = [...model.tests]
                          tests[i] = { ...t, desc: e.target.value }
                          setModel({ ...model, tests })
                        }}
                      />
                    </td>
                    <td>
                      <input
                        value={t.target}
                        onChange={(e) => {
                          const tests = [...model.tests]
                          tests[i] = { ...t, target: e.target.value }
                          setModel({ ...model, tests })
                        }}
                      />
                    </td>
                    <td>
                      <select
                        value={t.kind}
                        onChange={(e) => {
                          const tests = [...model.tests]
                          tests[i] = { ...t, kind: e.target.value }
                          setModel({ ...model, tests })
                        }}
                      >
                        <option value="public">public</option>
                        <option value="tcp">tcp</option>
                        <option value="domain">domain</option>
                      </select>
                    </td>
                    <td>
                      <input
                        className="ed-port"
                        value={t.port}
                        onChange={(e) => {
                          const tests = [...model.tests]
                          tests[i] = { ...t, port: e.target.value }
                          setModel({ ...model, tests })
                        }}
                      />
                    </td>
                    <td>
                      <button
                        className="danger"
                        onClick={() => setModel({ ...model, tests: model.tests.filter((_, j) => j !== i) })}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              onClick={() =>
                setModel({ ...model, tests: [...model.tests, { desc: '', target: '', kind: 'tcp', port: '443' }] })
              }
            >
              + 新增测试项
            </button>
          </section>
        </div>
      ) : (
        <div className="ed-body">
          <textarea
            className="ed-raw"
            spellCheck={false}
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
          />
        </div>
      )}
    </div>
  )
}
