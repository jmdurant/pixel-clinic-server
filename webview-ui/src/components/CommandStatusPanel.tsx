import { useEffect, useRef, useState } from 'react'
import type { ClinicRun } from '../hooks/useClinicCommands.js'

/**
 * Top-right live panel showing running clinic commands + tail of output.
 *
 * Collapsed by default when idle; auto-expands when a command starts.
 * Shows:
 *   - command + args
 *   - running spinner (pulsing dot) or exit status (green ✓ / red ✗)
 *   - elapsed time
 *   - last ~40KB of stdout+stderr (monospace, scroll-to-bottom)
 *   - cancel button while running
 *   - clear button for completed runs
 */

interface CommandStatusPanelProps {
  runs: ClinicRun[]
  onCancel: (runId: string) => void
}

const panelStyle = (expanded: boolean): React.CSSProperties => ({
  position: 'absolute',
  top: 10,
  right: 10,
  zIndex: 'var(--pixel-controls-z)',
  background: 'var(--pixel-bg)',
  border: '2px solid var(--pixel-border)',
  borderRadius: 0,
  boxShadow: 'var(--pixel-shadow)',
  width: expanded ? 520 : 220,
  maxHeight: expanded ? '70vh' : 48,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  transition: 'width 120ms ease, max-height 160ms ease',
})

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 10px',
  cursor: 'pointer',
  borderBottom: '2px solid var(--pixel-border)',
  background: 'var(--pixel-btn-bg)',
}

const cardStyle: React.CSSProperties = {
  borderBottom: '1px solid var(--pixel-border)',
  padding: '6px 10px',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
}

const outputStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: 13,
  lineHeight: 1.35,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  color: 'var(--pixel-text)',
  background: 'var(--pixel-active-bg)',
  border: '1px solid var(--pixel-border)',
  padding: 6,
  maxHeight: 220,
  overflowY: 'auto',
}

function formatElapsed(startedAt: number, running: boolean, nowTick: number): string {
  void nowTick // force re-render via closure
  const endedAt = running ? Date.now() : startedAt // we don't track end — clamped below
  const ms = Math.max(0, (running ? Date.now() : endedAt) - startedAt)
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}m ${r.toString().padStart(2, '0')}s`
}

function StatusPip({ running, exitCode }: { running: boolean; exitCode: number | null }) {
  if (running) {
    return (
      <span
        className="pixel-agents-pulse"
        style={{
          display: 'inline-block',
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: 'var(--vscode-charts-yellow, #cca700)',
          flexShrink: 0,
        }}
      />
    )
  }
  const ok = exitCode === 0
  return (
    <span
      style={{
        display: 'inline-block',
        width: 10,
        height: 10,
        borderRadius: '50%',
        background: ok ? 'var(--vscode-charts-green, #89d185)' : 'var(--vscode-charts-red, #f14c4c)',
        flexShrink: 0,
      }}
      title={ok ? 'Completed' : `Exit ${exitCode}`}
    />
  )
}

function RunCard({
  run,
  onCancel,
  onClear,
  nowTick,
}: {
  run: ClinicRun
  onCancel: () => void
  onClear: () => void
  nowTick: number
}) {
  const outputRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Auto-scroll to bottom as new chunks arrive.
    const el = outputRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [run.output])

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StatusPip running={run.running} exitCode={run.exitCode} />
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <div
            style={{
              fontSize: 14,
              fontFamily: 'ui-monospace, Menlo, monospace',
              color: 'var(--pixel-text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={`${run.command} ${run.args}`.trim()}
          >
            {run.command}
            {run.args && (
              <span style={{ opacity: 0.6 }}> {run.args}</span>
            )}
          </div>
          <div style={{ fontSize: 12, opacity: 0.6 }}>
            {formatElapsed(run.startedAt, run.running, nowTick)}
            {!run.running && run.exitCode !== null && ` · exit ${run.exitCode}`}
          </div>
        </div>
        {run.running ? (
          <button
            onClick={onCancel}
            style={{
              fontSize: 14,
              padding: '2px 8px',
              background: 'var(--pixel-btn-bg)',
              color: 'var(--pixel-text)',
              border: '2px solid var(--pixel-border)',
              cursor: 'pointer',
              borderRadius: 0,
            }}
            title="Send SIGTERM"
          >
            Cancel
          </button>
        ) : (
          <button
            onClick={onClear}
            style={{
              fontSize: 14,
              padding: '2px 8px',
              background: 'var(--pixel-btn-bg)',
              color: 'var(--pixel-text-dim)',
              border: '2px solid transparent',
              cursor: 'pointer',
              borderRadius: 0,
            }}
            title="Hide this run"
          >
            ✕
          </button>
        )}
      </div>
      {run.output && (
        <div ref={outputRef} style={outputStyle}>
          {run.output}
        </div>
      )}
    </div>
  )
}

export function CommandStatusPanel({ runs, onCancel }: CommandStatusPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [nowTick, setNowTick] = useState(0)

  // Auto-expand on first new running run.
  const anyRunning = runs.some((r) => r.running)
  useEffect(() => {
    if (anyRunning) setExpanded(true)
  }, [anyRunning])

  // Tick once a second while anything is running so elapsed time updates.
  useEffect(() => {
    if (!anyRunning) return
    const interval = setInterval(() => setNowTick((n) => n + 1), 1000)
    return () => clearInterval(interval)
  }, [anyRunning])

  const visible = runs.filter((r) => !hidden.has(r.runId))
  if (visible.length === 0) return null

  const active = visible.filter((r) => r.running)
  const headerLabel = active.length > 0
    ? `${active.length} running · ${visible.length} total`
    : `${visible.length} recent run${visible.length === 1 ? '' : 's'}`

  return (
    <div style={panelStyle(expanded)}>
      <div style={headerStyle} onClick={() => setExpanded((v) => !v)}>
        <StatusPip
          running={active.length > 0}
          exitCode={active.length === 0 ? (visible[0]?.exitCode ?? 0) : null}
        />
        <div style={{ flex: 1, fontSize: 16, color: 'var(--pixel-text)' }}>
          {headerLabel}
        </div>
        <span style={{ fontSize: 18, color: 'var(--pixel-text-dim)' }}>
          {expanded ? '▾' : '▸'}
        </span>
      </div>
      {expanded && (
        <div style={{ overflowY: 'auto' }}>
          {visible.map((r) => (
            <RunCard
              key={r.runId}
              run={r}
              nowTick={nowTick}
              onCancel={() => onCancel(r.runId)}
              onClear={() => setHidden((prev) => new Set(prev).add(r.runId))}
            />
          ))}
        </div>
      )}
    </div>
  )
}
