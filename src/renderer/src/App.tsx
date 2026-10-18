import { useEffect, useState, type ReactNode } from 'react'
import { useSystemStore } from './stores/system'
import { useNavigationStore, type HelmPageId } from './stores/navigation'
import { AgentsPanel } from './panels/Agents'
import { PortsPanel } from './panels/Ports'
import { GitStatusPanel } from './panels/GitStatus'
import { LogsPanel } from './panels/Logs'
import { BriefingPanel } from './panels/Briefing'
import { NotificationsPanel } from './panels/Notifications'
import { NetworkPanel } from './panels/Network'
import { ScorecardsStrip } from './panels/ScorecardsStrip'
import { GitHistoryPanel } from './panels/GitHistory'
import { CommandCenterPanel } from './panels/CommandCenter'
import { TimelinePanel, SessionDeltaBanner } from './panels/Timeline'
import { CommandPalette } from './panels/CommandPalette'
import { CCUsagePanel } from './panels/CCUsage'
import { FMRadioPanel } from './panels/FMRadio'
import { RegistryPanel } from './panels/Registry'
import { VaultPagePanel } from './panels/VaultPage'
import { HiveLauncher } from './panels/HiveLauncher'
import { HELM_SKINS, useSkinStore } from './stores/skin'
import { usePrivacyStore } from './stores/privacy'
import { SkinGlobe } from './components/SkinGlobe'
import { getAudioElement } from './stores/audio-engine'
import { EnterpriseNotice } from './components/EnterpriseNotice'
import type { SystemState, SentinelStatus } from '../../shared/types'

interface PageMeta {
  id: HelmPageId
  label: string
  kicker: string
  description: string
}

const PAGES: PageMeta[] = [
  {
    id: 'bridge',
    label: 'Overview',
    kicker: 'Your workspace',
    description: 'Live system pressure, agent signals and the work that needs your attention.'
  },
  {
    id: 'fleet',
    label: 'Fleet',
    kicker: 'Workspace ops',
    description: 'Keep workspaces, repository changes and recent commits in view.'
  },
  {
    id: 'swarm',
    label: 'Agent runs',
    kicker: 'Intent. Action. Evidence.',
    description: 'Define the task. Bound its permissions. Inspect the result.'
  },
  {
    id: 'grid',
    label: 'Grid',
    kicker: 'Network and ports',
    description: 'Inspect network activity and the ports listening on your machine.'
  },
  {
    id: 'ai',
    label: 'AI',
    kicker: 'Local AI control',
    description: 'Connect an optional model for system briefings and inspect recorded usage.'
  },
  {
    id: 'vault',
    label: 'Vault',
    kicker: 'Knowledge base',
    description: 'Search, browse, and manage your Obsidian vault via hybrid RAG.'
  },
  {
    id: 'registry',
    label: 'Registry',
    kicker: 'Hall of fame',
    description: 'Permanent historical record of every agent ever built. Ranked by impact.'
  },
  {
    id: 'radio',
    label: 'Radio',
    kicker: 'Audio relay',
    description: 'Audio lives here: FM presets, local MP3, and direct stream loading.'
  },
  {
    id: 'logs',
    label: 'Logs',
    kicker: 'Event stream',
    description: 'Follow events from your configured log sources.'
  }
]

const PAGE_ICONS: Record<HelmPageId, string> = {
  bridge: 'M3 3h5v5H3zM12 3h5v5h-5zM3 12h5v5H3zM12 12h5v5h-5z',
  fleet: 'M2 6h6l2 2h8v9H2zM2 6V3h6l2 3',
  swarm: 'M5 3l12 7-12 7V3z',
  grid: 'M2 11h3l3-7 4 12 3-7h3',
  ai: 'M10 2v4M10 14v4M2 10h4M14 10h4M5 5l2 2M13 13l2 2M5 15l2-2M13 7l2-2M7 7h6v6H7z',
  vault: 'M4 3h12v14H4zM7 7h6M7 10h6M7 13h4',
  registry: 'M3 4h14v12H3zM7 4v12M10 8h4M10 12h4',
  radio: 'M6 6a6 6 0 0 0 0 8M3 3a10 10 0 0 0 0 14M14 6a6 6 0 0 1 0 8M17 3a10 10 0 0 1 0 14M10 7v6',
  logs: 'M3 5h2M8 5h9M3 10h2M8 10h9M3 15h2M8 15h9'
}

function DashPanel({
  title,
  children,
  className = ''
}: {
  title: string
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <section className={`shell-panel min-h-0 flex flex-col overflow-hidden ${className}`}>
      <div className="shell-panel-header shrink-0">
        <h2 className="shell-panel-title text-[11px] font-semibold">{title}</h2>
      </div>
      <div className="shell-panel-body flex-1 min-h-0 overflow-auto">{children}</div>
    </section>
  )
}

function getShellHealth(state: SystemState | null): {
  dot: string
  glow: string
  label: string
} {
  if (!state) {
    return {
      dot: 'bg-gray-600',
      glow: 'shadow-gray-700/40',
      label: 'Booting monitors'
    }
  }

  if (state.cpu.usage >= 85 || state.memory.usagePercent >= 90) {
    return {
      dot: 'bg-red-400',
      glow: 'shadow-red-400/50',
      label: 'Pressure rising'
    }
  }

  if (state.cpu.usage >= 60 || state.memory.usagePercent >= 75) {
    return {
      dot: 'bg-amber-400',
      glow: 'shadow-amber-400/50',
      label: 'Watch load'
    }
  }

  return {
    dot: 'bg-green-400',
    glow: 'shadow-green-400/50',
    label: 'Systems nominal'
  }
}

function SkinCard({
  skin,
  active,
  onSelect
}: {
  skin: (typeof HELM_SKINS)[number]
  active: boolean
  onSelect: () => void
}): JSX.Element {
  return (
    <button
      onClick={onSelect}
      className={`shell-skin-card ${active ? 'shell-skin-card--active' : ''}`}
    >
      <div className="shell-skin-preview">
        {skin.palette.map((color, i) => (
          <div key={i} style={{ background: color, flex: i === 0 ? 3 : 1 }} />
        ))}
      </div>
      <div className="shell-skin-card-body">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-white">{skin.label}</span>
          {active && <span className="shell-skin-badge">Active</span>}
        </div>
        <p className="text-xs shell-muted mt-1">{skin.blurb}</p>
      </div>
    </button>
  )
}

function SkinSelectorPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const activeSkin = useSkinStore((s) => s.activeSkin)
  const setActiveSkin = useSkinStore((s) => s.setActiveSkin)

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div className="shell-command-overlay fixed inset-0 z-50" onClick={onClose}>
      <div className="shell-skin-panel" onClick={(e) => e.stopPropagation()}>
        <SkinGlobe />
        <div className="shell-skin-panel-header">
          <h3>Shell Skin</h3>
          <p>Choose the visual identity for your HELM shell.</p>
        </div>
        <div className="shell-skin-grid">
          {HELM_SKINS.map((skin) => (
            <SkinCard
              key={skin.id}
              skin={skin}
              active={skin.id === activeSkin}
              onSelect={() => {
                setActiveSkin(skin.id)
                onClose()
              }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function SkinChip({ onOpen }: { onOpen: () => void }): JSX.Element {
  const activeSkin = useSkinStore((s) => s.activeSkin)
  const skinMeta = HELM_SKINS.find((s) => s.id === activeSkin)
  return (
    <button
      onClick={onOpen}
      className="shell-control-button px-3 py-1.5 text-xs font-medium flex items-center gap-2"
    >
      <span className="w-2 h-2 rounded-full" style={{ background: 'var(--helm-accent)' }} />
      {skinMeta?.label ?? 'Skin'}
    </button>
  )
}

function PrivacyChip(): JSX.Element {
  const privacyMode = usePrivacyStore((s) => s.privacyMode)
  const togglePrivacyMode = usePrivacyStore((s) => s.togglePrivacyMode)

  return (
    <button
      type="button"
      onClick={togglePrivacyMode}
      title={
        privacyMode
          ? 'Secure View is on. Local paths, hosts, and endpoints are redacted.'
          : 'Secure View is off. Local paths, hosts, and endpoints may be visible.'
      }
      className="shell-control-button px-3 py-1.5 text-xs font-medium flex items-center gap-2"
    >
      <span
        className={`h-2 w-2 rounded-full ${
          privacyMode
            ? 'bg-emerald-300 shadow-[0_0_8px_rgba(110,231,183,0.8)]'
            : 'bg-amber-300 shadow-[0_0_8px_rgba(252,211,77,0.8)]'
        }`}
      />
      {privacyMode ? 'Secure On' : 'Secure Off'}
    </button>
  )
}

function SentinelChip(): JSX.Element {
  const [status, setStatus] = useState<SentinelStatus | null>(null)
  const setCurrentPage = useNavigationStore((s) => s.setCurrentPage)

  useEffect(() => {
    window.helm.getSentinelStatus().then(setStatus)
    const interval = setInterval(() => {
      window.helm.getSentinelStatus().then(setStatus)
    }, 15000)
    return () => clearInterval(interval)
  }, [])

  if (!status || !status.enabled) return <></>

  const hasCritical = status.activeAlerts.some(
    (a) => a.severity === 'critical' || a.severity === 'warning'
  )
  const hasInfo = status.activeAlerts.some((a) => a.severity === 'info')
  const dotColor = hasCritical
    ? 'bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.8)]'
    : hasInfo
      ? 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)]'
      : 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.5)]'

  return (
    <button
      type="button"
      onClick={() => setCurrentPage('logs')}
      title={`Sentinel: ${status.activeAlerts.length} alerts in last hour, ${status.rulesEnabled} rules active`}
      className="shell-control-button px-3 py-1.5 text-xs font-medium flex items-center gap-2"
    >
      <span className={`w-2 h-2 rounded-full ${dotColor}`} />
      Sentinel
    </button>
  )
}

function Header({ onOpenSkinSelector }: { onOpenSkinSelector: () => void }): JSX.Element {
  const state = useSystemStore((s) => s.state)
  const refresh = useSystemStore((s) => s.refresh)
  const health = getShellHealth(state)
  const isFresh = state ? Date.now() - state.timestamp < 5000 : false

  return (
    <header className="shell-header chrome-brushed px-4 py-2 flex items-center gap-4 relative shrink-0 border-b">
      <div className="flex shrink-0 items-center gap-3">
        <div className={`w-2.5 h-2.5 rounded-full ${health.dot} shadow-md ${health.glow}`} />
        <div>
          <div className="flex items-center gap-2">
            <svg className="shell-brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <path
                d="M4 5v22M28 5v22M4 16h24M10 10v12M22 10v12"
                stroke="currentColor"
                strokeWidth="2"
              />
              <circle cx="16" cy="16" r="3" fill="currentColor" />
            </svg>
            <h1 className="shell-brand-word">HELM</h1>
            <span className="shell-brand-version">06</span>
          </div>
          <div className="text-[11px] shell-subtle">{health.label}</div>
        </div>
      </div>

      <div className="shell-header-context">
        <span>Personal workspace</span>
        <span aria-hidden="true">/</span>
        <span>Local machine</span>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-3">
        <div className="hidden sm:flex items-center gap-2">
          <SentinelChip />
          <PrivacyChip />
          <SkinChip onOpen={onOpenSkinSelector} />
        </div>
        <button
          type="button"
          onClick={refresh}
          className="shell-control-button px-3 py-1.5 text-xs font-medium"
        >
          Refresh
        </button>
        {state && (
          <div className="flex items-center gap-2">
            <span
              className={`w-1.5 h-1.5 rounded-full ${isFresh ? 'bg-green-400' : 'bg-gray-600'}`}
            />
            <span className="text-xs shell-subtle font-mono tabular-nums">
              {new Date(state.timestamp).toLocaleTimeString()}
            </span>
          </div>
        )}
      </div>
    </header>
  )
}

function PageHeader({ meta }: { meta: PageMeta }): JSX.Element {
  const setCurrentPage = useNavigationStore((s) => s.setCurrentPage)
  return (
    <div className="shell-page-header px-4 py-2">
      <div>
        <div className="shell-page-kicker text-[9px] uppercase tracking-[0.16em]">
          {meta.kicker}
        </div>
        <h2 className="shell-page-title">
          {meta.id === 'bridge' ? (
            <>
              Everything <em>in hand.</em>
            </>
          ) : (
            meta.label
          )}
        </h2>
        <p className="pt-1 text-sm shell-subtle max-w-[56rem]">{meta.description}</p>
      </div>
      {meta.id !== 'swarm' && (
        <button
          type="button"
          className="shell-primary-button"
          onClick={() => setCurrentPage('swarm')}
        >
          + Launch agent
        </button>
      )}
    </div>
  )
}

function BridgePage(): JSX.Element {
  const state = useSystemStore((s) => s.state)
  if (!state) return <></>

  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(290px,0.9fr)]">
        <DashPanel title="Command Center" className="min-h-[460px]">
          <div className="flex h-full flex-col gap-3">
            <div className="px-1 text-[11px] shell-subtle">
              Top pressure only. Full workspace control lives in Fleet.
            </div>
            <div className="min-h-0 flex-1">
              <CommandCenterPanel mode="overview" maxGroups={6} />
            </div>
          </div>
        </DashPanel>
        <div className="grid gap-4 auto-rows-fr">
          <DashPanel title="Operator Briefing" className="min-h-[300px]">
            <BriefingPanel variant="compact" />
          </DashPanel>
          <DashPanel title="Notifications" className="min-h-[220px]">
            <NotificationsPanel />
          </DashPanel>
        </div>
      </div>
    </div>
  )
}

function FleetPage(): JSX.Element {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(290px,0.85fr)]">
        <DashPanel title="Workspace Control" className="min-h-[420px]">
          <CommandCenterPanel initialSortMode="workspace" showSortControls />
        </DashPanel>
        <DashPanel title="Git Status" className="min-h-[420px]">
          <GitStatusPanel />
        </DashPanel>
      </div>
      <DashPanel title="Git History" className="min-h-[300px]">
        <GitHistoryPanel />
      </DashPanel>
    </div>
  )
}

function SwarmPage(): JSX.Element {
  return (
    <div className="space-y-4">
      <DashPanel title="Launch and supervise">
        <HiveLauncher />
      </DashPanel>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(280px,0.8fr)]">
        <DashPanel title="Agent signals" className="min-h-[300px]">
          <AgentsPanel />
        </DashPanel>
        <DashPanel title="Swarm Timeline" className="min-h-[300px]">
          <TimelinePanel />
        </DashPanel>
      </div>
    </div>
  )
}

function GridPage(): JSX.Element {
  return (
    <div className="space-y-4">
      <DashPanel title="Network Traffic" className="min-h-[360px]">
        <NetworkPanel />
      </DashPanel>
      <DashPanel title="Listening Ports" className="min-h-[280px]">
        <PortsPanel />
      </DashPanel>
    </div>
  )
}

function AIPage(): JSX.Element {
  return (
    <div className="space-y-4">
      <DashPanel title="AI Control" className="min-h-[420px]">
        <BriefingPanel variant="full" />
      </DashPanel>
      <DashPanel title="Spend & Usage" className="min-h-[400px]">
        <CCUsagePanel />
      </DashPanel>
    </div>
  )
}

function VaultPage(): JSX.Element {
  return (
    <div className="space-y-4">
      <DashPanel title="Vault" className="min-h-[620px]">
        <VaultPagePanel />
      </DashPanel>
    </div>
  )
}

function RegistryPage(): JSX.Element {
  return (
    <div className="space-y-4">
      <DashPanel title="Agent Registry" className="min-h-[600px]">
        <RegistryPanel />
      </DashPanel>
    </div>
  )
}

function RadioPage(): JSX.Element {
  return (
    <div className="space-y-4">
      <DashPanel title="FM Radio" className="min-h-[580px]">
        <FMRadioPanel />
      </DashPanel>
    </div>
  )
}

function LogsPage(): JSX.Element {
  return (
    <div className="space-y-4">
      <DashPanel title="System Logs" className="min-h-[600px]">
        <LogsPanel />
      </DashPanel>
    </div>
  )
}

function NavGlyph({ pageId }: { pageId: HelmPageId }): JSX.Element {
  return (
    <svg className="shell-nav-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d={PAGE_ICONS[pageId]}
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function NavBadge({
  pageId,
  active = false
}: {
  pageId: HelmPageId
  active?: boolean
}): JSX.Element | null {
  const state = useSystemStore((s) => s.state)
  if (!state) return <span className="shell-nav-badge text-[10px]">-</span>

  let badge: string
  switch (pageId) {
    case 'bridge':
      badge = `${state.agents.length}`
      break
    case 'fleet':
      badge = `${state.gitRepos.length}`
      break
    case 'swarm':
      badge = `${state.agents.length}`
      break
    case 'grid':
      badge = `${state.ports.filter((port) => port.state === 'LISTEN').length}`
      break
    case 'ai':
    case 'vault':
    case 'logs':
      return null
    case 'registry':
      return null
    case 'radio':
      badge = 'fm'
      break
    default:
      badge = '-'
  }

  return (
    <span
      className={`shell-nav-badge rounded-full px-2 py-0.5 text-[10px] ${active ? 'shell-nav-badge--active' : ''}`}
    >
      {badge}
    </span>
  )
}

function ShellNav({
  currentPage,
  setCurrentPage
}: {
  currentPage: HelmPageId
  setCurrentPage: (page: HelmPageId) => void
}): JSX.Element {
  return (
    <>
      <aside className="shell-nav shrink-0 flex-col p-2">
        <div className="px-2 pb-2">
          <div className="shell-page-kicker text-[9px] uppercase tracking-[0.14em]">
            Your workspace
          </div>
        </div>

        <nav className="shell-nav-links pt-2 space-y-1.5 px-1 flex-1 min-h-0 overflow-y-auto">
          {PAGES.map((page) => {
            const active = page.id === currentPage
            return (
              <button
                key={page.id}
                type="button"
                onClick={() => setCurrentPage(page.id)}
                aria-current={active ? 'page' : undefined}
                className={`shell-nav-button w-full text-left ${active ? 'shell-nav-button--active' : 'shell-nav-button--inactive'}`}
              >
                <div className="flex items-center gap-3">
                  <NavGlyph pageId={page.id} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-semibold text-white">{page.label}</div>
                      <NavBadge pageId={page.id} active={active} />
                    </div>
                    <div
                      className={`pt-1 text-[10px] uppercase tracking-[0.22em] ${active ? 'text-white/80' : 'shell-subtle'}`}
                    >
                      {page.kicker}
                    </div>
                  </div>
                </div>
              </button>
            )
          })}
        </nav>
        <div className="shell-nav-note">
          <strong>Intent. Action. Evidence.</strong>
          <span>
            Keep the work in view.
            <br />
            Keep the decisions yours.
          </span>
        </div>
        <EnterpriseNotice />
      </aside>

      <div className="shell-compact-nav overflow-x-auto">
        <div className="flex gap-2 min-w-max">
          {PAGES.map((page) => {
            const active = page.id === currentPage
            return (
              <button
                key={page.id}
                type="button"
                onClick={() => setCurrentPage(page.id)}
                aria-current={active ? 'page' : undefined}
                className={`shell-mobile-nav-button rounded-full px-3 py-2 text-xs transition-colors ${
                  active ? 'shell-mobile-nav-button--active text-white' : 'shell-subtle'
                }`}
              >
                {page.label}
              </button>
            )
          })}
        </div>
        <EnterpriseNotice />
      </div>
    </>
  )
}

function PageContent({ currentPage }: { currentPage: HelmPageId }): JSX.Element {
  switch (currentPage) {
    case 'bridge':
      return <BridgePage />
    case 'fleet':
      return <FleetPage />
    case 'swarm':
      return <SwarmPage />
    case 'grid':
      return <GridPage />
    case 'ai':
      return <AIPage />
    case 'vault':
      return <VaultPage />
    case 'registry':
      return <RegistryPage />
    case 'radio':
      return <RadioPage />
    case 'logs':
      return <LogsPage />
    default:
      return <BridgePage />
  }
}

function App(): JSX.Element {
  const activeSkin = useSkinStore((s) => s.activeSkin)
  const isReady = useSystemStore((s) => s.state !== null)
  const initialize = useSystemStore((s) => s.initialize)
  const currentPage = useNavigationStore((s) => s.currentPage)
  const setCurrentPage = useNavigationStore((s) => s.setCurrentPage)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [skinOpen, setSkinOpen] = useState(false)

  useEffect(() => {
    initialize()
    getAudioElement()
  }, [initialize])

  useEffect(() => {
    const updateVisibility = (): void => {
      document.documentElement.dataset.hidden = String(document.hidden)
    }
    updateVisibility()
    document.addEventListener('visibilitychange', updateVisibility)
    return () => document.removeEventListener('visibilitychange', updateVisibility)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.skin = activeSkin
    return () => {
      delete document.documentElement.dataset.skin
    }
  }, [activeSkin])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault()
        setPaletteOpen((prev) => !prev)
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        (event.key === 's' || event.key === 'S')
      ) {
        event.preventDefault()
        setSkinOpen((prev) => !prev)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  if (!isReady) {
    return (
      <div
        className="helm-shell shell-loading flex items-center justify-center h-screen"
        data-skin={activeSkin}
      >
        <div className="text-center">
          <div className="mb-2 text-2xl font-semibold tracking-[0.28em] text-white">HELM</div>
          <div className="text-sm shell-subtle">Connecting to system monitors...</div>
        </div>
      </div>
    )
  }

  const activePageMeta = PAGES.find((page) => page.id === currentPage) || PAGES[0]

  return (
    <div
      className="helm-shell crt-grid h-screen flex flex-col overflow-hidden"
      data-skin={activeSkin}
    >
      <Header onOpenSkinSelector={() => setSkinOpen(true)} />

      <div className="signal-body flex-1 min-h-0">
        <div className="signal-layout h-full min-h-0">
          <ShellNav currentPage={currentPage} setCurrentPage={setCurrentPage} />

          <main className="shell-main flex-1 min-h-0 overflow-hidden flex flex-col">
            <div className="shell-page-scroll flex-1 min-h-0 overflow-y-auto">
              <PageHeader meta={activePageMeta} />
              <div className="shell-metrics">
                <ScorecardsStrip />
              </div>
              {(currentPage === 'bridge' || currentPage === 'fleet') && <SessionDeltaBanner />}
              <div className="shell-page-content" key={currentPage}>
                <PageContent currentPage={currentPage} />
              </div>
            </div>
          </main>
        </div>
      </div>

      <CommandPalette isOpen={paletteOpen} onClose={() => setPaletteOpen(false)} />
      {skinOpen && <SkinSelectorPanel onClose={() => setSkinOpen(false)} />}
    </div>
  )
}

export default App
