// 面板主界面：状态展示 + 一键 apply/clean + 设置 + 事件流水
import { useCallback, useEffect, useState } from 'react'
import type { Phase, ScriptEvent, StatusReport, TestItem } from '@shared/types'
import { isKnownEvent } from '@shared/types'
import EventLog from './EventLog'
import LearnWizard from './LearnWizard'

interface SettingsShape {
  autoApplyEnabled: boolean
  autoApplySettleSeconds: number
  autoApplyCooldownSeconds: number
  patrolEnabled: boolean
  patrolIntervalSeconds: number
  confPath: string
  theme: 'system' | 'dark' | 'light'
}

const PHASE_LABEL: Record<Phase, { text: string; color: string }> = {
  unknown: { text: '未检查', color: 'var(--grey)' },
  checking: { text: '检查中…', color: 'var(--grey)' },
  busy: { text: '操作进行中', color: 'var(--blue)' },
  ok: { text: '全部正常', color: 'var(--green)' },
  degraded: { text: '部分异常', color: 'var(--yellow)' },
  failed: { text: '异常', color: 'var(--red)' }
}

export default function App(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('unknown')
  const [status, setStatus] = useState<StatusReport | null>(null)
  const [tests, setTests] = useState<TestItem[]>([])
  const [events, setEvents] = useState<ScriptEvent[]>([])
  const [busy, setBusy] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<string>('')
  const [settings, setSettings] = useState<SettingsShape | null>(null)
  const [nopasswd, setNopasswd] = useState<boolean | null>(null)
  const [sudoBusy, setSudoBusy] = useState(false)
  const [openAtLogin, setOpenAtLogin] = useState(false)
  const [profiles, setProfiles] = useState<{ name: string; path: string; active: boolean }[]>([])

  const reloadProfiles = useCallback(async (): Promise<void> => {
    setProfiles(await window.api.profilesList())
  }, [])

  const switchProfile = useCallback(
    async (path: string): Promise<void> => {
      await window.api.profilesSwitch(path)
      setSettings(await (window.api.settingsGet() as Promise<SettingsShape>))
      await reloadProfiles()
      setUpdatedAt(new Date().toLocaleTimeString('zh-CN'))
    },
    [reloadProfiles]
  )

  useEffect(() => {
    const offPhase = window.api.onPhase(setPhase)
    const offScript = window.api.onScriptEvent((ev: ScriptEvent) => {
      setEvents((prev) => [...prev.slice(-199), ev])
      if (!isKnownEvent(ev)) return
      switch (ev.event) {
        case 'status':
          setStatus(ev)
          break
        case 'test_item':
          setTests((prev) => {
            const idx = prev.findIndex((t) => t.index === ev.index)
            const next = idx >= 0 ? prev.map((t, i) => (i === idx ? ev : t)) : [...prev, ev]
            return next.sort((a, b) => a.index - b.index)
          })
          break
        case 'test_start':
          setTests([])
          break
        default:
          break
      }
    })
    // 初次拉取
    void window.api.status()
    return () => {
      offPhase()
      offScript()
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    setBusy(true)
    await window.api.status()
    setBusy(false)
    setUpdatedAt(new Date().toLocaleTimeString('zh-CN'))
  }, [])

  const runTests = useCallback(async (): Promise<void> => {
    setBusy(true)
    await window.api.test()
    setBusy(false)
    setUpdatedAt(new Date().toLocaleTimeString('zh-CN'))
  }, [])

  const apply = useCallback(async (): Promise<void> => {
    setBusy(true)
    const r = await window.api.apply()
    setBusy(false)
    setUpdatedAt(new Date().toLocaleTimeString('zh-CN'))
    if (r.cancelled) setEvents((prev) => [...prev, { event: 'error', code: 'cancelled', message: '已取消授权' }])
  }, [])

  const clean = useCallback(async (): Promise<void> => {
    if (!window.confirm('清理所有已配置的路由？')) return
    setBusy(true)
    const r = await window.api.clean()
    setBusy(false)
    if (r.cancelled) setEvents((prev) => [...prev, { event: 'error', code: 'cancelled', message: '已取消授权' }])
  }, [])

  useEffect(() => {
    void window.api.settingsGet().then((s) => setSettings(s as SettingsShape))
    void window.api.sudoProbe().then(setNopasswd)
    void window.api.getOpenAtLogin().then(setOpenAtLogin)
    void reloadProfiles()
  }, [reloadProfiles])

  const installSudo = useCallback(async (): Promise<void> => {
    setSudoBusy(true)
    const r = await window.api.sudoInstall()
    setSudoBusy(false)
    if (r.ok) setNopasswd(true)
    else if (r.cancelled) setEvents((prev) => [...prev, { event: 'error', code: 'cancelled', message: '已取消授权' }])
    else if (r.error) setEvents((prev) => [...prev, { event: 'error', code: 'sudo-install', message: r.error! }])
  }, [])

  const uninstallSudo = useCallback(async (): Promise<void> => {
    if (!window.confirm('移除免密授权（sudoers 条目与 root 脚本副本）？')) return
    setSudoBusy(true)
    const r = await window.api.sudoUninstall(true)
    setSudoBusy(false)
    if (r.ok) setNopasswd(false)
  }, [])

  const toggleAutoApply = useCallback(async (): Promise<void> => {
    if (!settings) return
    const next = { autoApplyEnabled: !settings.autoApplyEnabled }
    setSettings({ ...settings, ...next })
    await window.api.settingsSet(next)
  }, [settings])

  const togglePatrol = useCallback(async (): Promise<void> => {
    if (!settings) return
    const next = { patrolEnabled: !settings.patrolEnabled }
    setSettings({ ...settings, ...next })
    await window.api.settingsSet(next)
  }, [settings])

  const setTheme = useCallback(
    async (theme: SettingsShape['theme']): Promise<void> => {
      if (!settings) return
      setSettings({ ...settings, theme })
      await window.api.settingsSet({ theme })
    },
    [settings]
  )

  const p = PHASE_LABEL[phase]

  return (
    <div className="panel">
      <header className="header">
        <div className="title">
          <span className="dot" style={{ background: p.color }} />
          <span>{p.text}</span>
        </div>
        <div className="actions">
          <button onClick={runTests} disabled={busy}>
            测试
          </button>
          <button onClick={refresh} disabled={busy}>
            刷新
          </button>
        </div>
      </header>

      <div className="op-bar">
        <button className="primary" onClick={apply} disabled={busy}>
          {phase === 'busy' ? '执行中…' : '一键 Apply'}
        </button>
        <button className="danger" onClick={clean} disabled={busy}>
          Clean
        </button>
      </div>

      {status && (
        <section className="card">
          <div className="card-title">VPN 网卡</div>
          {status.vpns.map((v) => (
            <div key={v.name} className="vpn-row">
              <div className="vpn-head">
                <span className={`badge ${v.detected ? 'ok' : 'fail'}`}>
                  {v.detected ? '✓' : '✗'}
                </span>
                <span className="vpn-name">{v.name}</span>
                {v.detected ? (
                  <span className="vpn-if">
                    {v.interface} · {v.ipv4 ?? '-'}
                    {v.method ? <span className="method"> ({v.method})</span> : null}
                  </span>
                ) : (
                  <span className="vpn-if miss">未检测到</span>
                )}
              </div>
              {v.routes.length > 0 && (
                <ul className="routes">
                  {v.routes.map((r) => (
                    <li key={r.target} className={r.ok ? '' : 'bad'}>
                      <span className={`mark ${r.ok ? 'ok' : 'fail'}`}>{r.ok ? '✓' : '✗'}</span>
                      <code>{r.target}</code>
                      <span className="arrow">→</span>
                      <span className={r.actual ? '' : 'miss'}>{r.actual ?? '未配置'}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          {status.default_route && (
            <div className="default-route">
              默认路由: <code>{status.default_route.gateway}</code> @ {status.default_route.interface}
            </div>
          )}
        </section>
      )}

      {tests.length > 0 && (
        <section className="card">
          <div className="card-title">连通性测试</div>
          <ul className="tests">
            {tests.map((t) => (
              <li key={t.index}>
                <span className={`mark ${t.result}`}>{ICON[t.result]}</span>
                <span className="t-desc">{t.desc}</span>
                <span className={`t-detail ${t.result}`}>{t.detail}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <EventLog events={events} />

      <LearnWizard onDone={refresh} />

      <section className="card">
        <div className="card-title">设置</div>
        {profiles.length > 1 && (
          <div className="setting-row">
            <span>Profile</span>
            <select className="profile-select" value={profiles.find((p) => p.active)?.path ?? ''} onChange={(e) => void switchProfile(e.target.value)}>
              {profiles.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="setting-row">
          <span>外观</span>
          <select
            className="theme-select"
            value={settings?.theme ?? 'system'}
            onChange={(e) => void setTheme(e.target.value as SettingsShape['theme'])}
          >
            <option value="system">跟随系统</option>
            <option value="dark">深色</option>
            <option value="light">浅色</option>
          </select>
        </div>
        <div className="setting-row">
          <span>自动 Apply</span>
          <button className={`switch ${settings?.autoApplyEnabled ? 'on' : ''}`} onClick={toggleAutoApply} disabled={!settings}>
            {settings?.autoApplyEnabled ? '开' : '关'}
          </button>
        </div>
        <div className="setting-row">
          <span>免密授权 {nopasswd === null ? '…' : nopasswd ? '✓ 已安装' : '✗ 未安装'}</span>
          {nopasswd ? (
            <button onClick={uninstallSudo} disabled={sudoBusy}>
              移除
            </button>
          ) : (
            <button className="primary" onClick={installSudo} disabled={sudoBusy}>
              {sudoBusy ? '安装中…' : '安装'}
            </button>
          )}
        </div>
        <div className="setting-row">
          <span>定时巡检（{settings?.patrolIntervalSeconds ?? 60}s）</span>
          <button
            className={`switch ${settings?.patrolEnabled ? 'on' : ''}`}
            onClick={togglePatrol}
            disabled={!settings}
          >
            {settings?.patrolEnabled ? '开' : '关'}
          </button>
        </div>
        <div className="setting-row">
          <span>开机启动</span>
          <button
            className={`switch ${openAtLogin ? 'on' : ''}`}
            onClick={async () => setOpenAtLogin(await window.api.setOpenAtLogin(!openAtLogin))}
          >
            {openAtLogin ? '开' : '关'}
          </button>
        </div>
        {nopasswd === false && (
          <div className="setting-hint">
            未安装时手动 Apply 需每次输密码，自动 Apply 不可用。安装 = 以 root 存放脚本副本 +
            写入 /etc/sudoers.d 精确白名单（仅 apply/clean 两条命令）。
          </div>
        )}
      </section>

      <footer className="footer">
        {updatedAt ? `更新于 ${updatedAt}` : ''}
        {status ? ` · ${status.conf}` : ''}
      </footer>
    </div>
  )
}

const ICON: Record<string, string> = { ok: '✅', warn: '⚠️', fail: '❌' }
