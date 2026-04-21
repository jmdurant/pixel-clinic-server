import { useEffect, useRef, useState } from 'react'

/**
 * Top-left pixel-styled bar of buttons that trigger clinic slash commands.
 *
 * Three top-level buttons:
 *   - Smoke test: /clinic-day-run (with a dropdown for --dry-run, --arc=A|B|C)
 *   - Scenarios:  /scenario-run (with a dropdown for categories + --all)
 *   - Agents:     /clinic-* individual agent commands
 *
 * Each button opens a pop-up menu with specific variants. Selecting a variant
 * fires `onRun(command, args)`, which delegates to useClinicCommands.run().
 * A small spinner pip is shown on the button if any command is currently
 * running. Cancellation is wired through the status panel (not here) so the
 * bar stays focused on "start something".
 */

interface ActionsBarProps {
  anyRunning: boolean
  activeCount: number
  onRun: (command: string, args?: string) => void
}

interface MenuItem {
  label: string
  command: string
  args?: string
  hint?: string
}

const BASELINE_MENU: MenuItem[] = [
  { label: 'Dry-run (validate prereqs)', command: '/clinic-day-run', args: '--dry-run',  hint: 'No tool calls fire' },
  { label: 'Full baseline (1A / 3B / 1C)', command: '/clinic-day-run' },
  { label: 'Arc A only — new patient',   command: '/clinic-day-run', args: '--arc=A' },
  { label: 'Arc B only — follow-up',     command: '/clinic-day-run', args: '--arc=B' },
  { label: 'Arc C only — referral loop', command: '/clinic-day-run', args: '--arc=C' },
]

const SCENARIO_MENU: MenuItem[] = [
  { label: 'All scenarios',             command: '/scenario-run', args: '--all' },
  { label: 'Red-team suite',            command: '/scenario-run', args: '--category=red-team' },
  { label: 'Operational suite',         command: '/scenario-run', args: '--category=operational' },
  { label: 'Clinical suite',            command: '/scenario-run', args: '--category=clinical' },
  { label: 'Multi-agent suite',         command: '/scenario-run', args: '--category=multi-agent' },
  { label: 'Compliance suite',          command: '/scenario-run', args: '--category=compliance' },
  { label: 'Longitudinal suite',        command: '/scenario-run', args: '--category=longitudinal' },
]

const AGENT_MENU: MenuItem[] = [
  { label: 'CR: tomorrow chart prep',       command: '/clinic-cr-prep' },
  { label: 'Nurse: portal check',           command: '/clinic-nurse-check' },
  { label: 'Receptionist: inbox scan',      command: '/clinic-receptionist-check' },
  { label: 'Admin: end-of-day close',       command: '/clinic-admin-close' },
  { label: 'HR: daily credential sweep',    command: '/clinic-hr-daily' },
  { label: 'IT: weekly compliance scan',    command: '/clinic-it-weekly' },
  { label: 'Liaison: morning digest',       command: '/clinic-liaison-morning' },
  { label: 'Liaison: afternoon inbox',      command: '/clinic-liaison-inbox' },
  { label: 'Marketing: morning digest',     command: '/clinic-marketing-morning' },
]

// ──────────────────────────────────────────────────────────────────────────
// Styles (match BottomToolbar aesthetic)
// ──────────────────────────────────────────────────────────────────────────

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  top: 10,
  left: 10,
  zIndex: 'var(--pixel-controls-z)',
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  background: 'var(--pixel-bg)',
  border: '2px solid var(--pixel-border)',
  borderRadius: 0,
  padding: '4px 6px',
  boxShadow: 'var(--pixel-shadow)',
}

const btnBase: React.CSSProperties = {
  padding: '5px 10px',
  fontSize: '22px',
  color: 'var(--pixel-text)',
  background: 'var(--pixel-btn-bg)',
  border: '2px solid transparent',
  borderRadius: 0,
  cursor: 'pointer',
  position: 'relative',
}

const btnActive: React.CSSProperties = {
  ...btnBase,
  background: 'var(--pixel-active-bg)',
  border: '2px solid var(--pixel-accent)',
}

const menuStyle: React.CSSProperties = {
  position: 'absolute',
  top: '100%',
  left: 0,
  marginTop: 4,
  background: 'var(--pixel-bg)',
  border: '2px solid var(--pixel-border)',
  borderRadius: 0,
  boxShadow: 'var(--pixel-shadow)',
  minWidth: 260,
  zIndex: 'var(--pixel-controls-z)',
  padding: 2,
}

const menuItemStyle = (hovered: boolean): React.CSSProperties => ({
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '6px 10px',
  fontSize: '20px',
  color: 'var(--pixel-text)',
  background: hovered ? 'var(--pixel-btn-hover-bg)' : 'transparent',
  border: 'none',
  borderRadius: 0,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
})

// ──────────────────────────────────────────────────────────────────────────

function Pip({ color }: { color: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: color,
        marginLeft: 6,
        verticalAlign: 'middle',
      }}
    />
  )
}

function Dropdown({
  label,
  items,
  anyRunning,
  onSelect,
}: {
  label: string
  items: MenuItem[]
  anyRunning: boolean
  onSelect: (item: MenuItem) => void
}) {
  const [open, setOpen] = useState(false)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={open ? btnActive : btnBase}
        title={label}
      >
        {label}
        {anyRunning && <Pip color="#cca700" />}
      </button>
      {open && (
        <div style={menuStyle}>
          {items.map((item, i) => (
            <button
              key={`${item.command}|${item.args ?? ''}`}
              style={menuItemStyle(hoverIdx === i)}
              onMouseEnter={() => setHoverIdx(i)}
              onMouseLeave={() => setHoverIdx(null)}
              onClick={() => {
                setOpen(false)
                onSelect(item)
              }}
            >
              <span>{item.label}</span>
              {item.hint && (
                <span style={{ float: 'right', opacity: 0.6, fontSize: 16, marginLeft: 20 }}>
                  {item.hint}
                </span>
              )}
              <div style={{ fontSize: 14, opacity: 0.5, marginTop: 2, fontFamily: 'monospace' }}>
                {item.command}
                {item.args ? ` ${item.args}` : ''}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function ActionsBar({ anyRunning, activeCount, onRun }: ActionsBarProps) {
  const handleSelect = (item: MenuItem) => {
    onRun(item.command, item.args ?? '')
  }

  return (
    <div style={panelStyle}>
      <Dropdown
        label="Run clinic day"
        items={BASELINE_MENU}
        anyRunning={anyRunning}
        onSelect={handleSelect}
      />
      <Dropdown
        label="Scenarios"
        items={SCENARIO_MENU}
        anyRunning={anyRunning}
        onSelect={handleSelect}
      />
      <Dropdown
        label="Agents"
        items={AGENT_MENU}
        anyRunning={anyRunning}
        onSelect={handleSelect}
      />
      {activeCount > 0 && (
        <span
          style={{
            fontSize: 18,
            color: 'var(--pixel-text-dim)',
            marginLeft: 6,
            padding: '2px 8px',
            border: '2px solid var(--pixel-accent)',
            background: 'var(--pixel-active-bg)',
          }}
          title={`${activeCount} clinic command${activeCount === 1 ? '' : 's'} running`}
        >
          ● {activeCount}
        </span>
      )}
    </div>
  )
}
