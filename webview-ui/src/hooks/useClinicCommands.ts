import { useCallback, useEffect, useRef, useState } from 'react'
import { vscode } from '../vscodeApi.js'

/**
 * State + controls for clinic-command buttons.
 *
 * Subscribes to server events (clinicCommandStarted/Status/Done/List),
 * tracks per-run metadata and a rolling output buffer, and exposes small
 * imperative helpers (run, cancel).
 *
 * The output buffer is capped per-run to keep the DOM cheap — deep tails
 * of long `/clinic-day-run` streams shouldn't balloon memory.
 */

const MAX_TAIL_PER_RUN = 40_000 // chars

export interface ClinicRun {
  runId: string
  command: string
  args: string
  startedAt: number
  running: boolean
  exitCode: number | null
  output: string
}

interface ClinicStartedMsg {
  type: 'clinicCommandStarted'
  runId: string
  command: string
  args?: string
  startedAt: number
}

interface ClinicStatusMsg {
  type: 'clinicCommandStatus'
  runId: string
  stream: 'stdout' | 'stderr'
  chunk: string
  replay?: boolean
}

interface ClinicDoneMsg {
  type: 'clinicCommandDone'
  runId: string
  exitCode: number
  durationMs: number
}

interface ClinicListMsg {
  type: 'clinicCommandList'
  runs: Array<{
    runId: string
    command: string
    args: string
    startedAt: number
    running: boolean
    exitCode: number | null
  }>
}

type Msg = ClinicStartedMsg | ClinicStatusMsg | ClinicDoneMsg | ClinicListMsg

export function useClinicCommands() {
  const [runs, setRuns] = useState<Record<string, ClinicRun>>({})
  // useRef mirror so the event handler always has the current map without
  // re-registering on every state update.
  const runsRef = useRef(runs)
  runsRef.current = runs

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data as Msg
      if (!msg || typeof msg !== 'object' || !msg.type) return

      if (msg.type === 'clinicCommandStarted') {
        setRuns((prev) => ({
          ...prev,
          [msg.runId]: {
            runId: msg.runId,
            command: msg.command,
            args: msg.args ?? '',
            startedAt: msg.startedAt,
            running: true,
            exitCode: null,
            output: '',
          },
        }))
        return
      }

      if (msg.type === 'clinicCommandStatus') {
        setRuns((prev) => {
          const existing = prev[msg.runId]
          if (!existing) return prev
          const nextOutput = (existing.output + msg.chunk).slice(-MAX_TAIL_PER_RUN)
          return { ...prev, [msg.runId]: { ...existing, output: nextOutput } }
        })
        return
      }

      if (msg.type === 'clinicCommandDone') {
        setRuns((prev) => {
          const existing = prev[msg.runId]
          if (!existing) return prev
          return {
            ...prev,
            [msg.runId]: { ...existing, running: false, exitCode: msg.exitCode },
          }
        })
        return
      }

      if (msg.type === 'clinicCommandList') {
        setRuns((prev) => {
          const next: Record<string, ClinicRun> = { ...prev }
          for (const r of msg.runs) {
            if (!next[r.runId]) {
              next[r.runId] = {
                runId: r.runId,
                command: r.command,
                args: r.args,
                startedAt: r.startedAt,
                running: r.running,
                exitCode: r.exitCode,
                output: '',
              }
            } else {
              next[r.runId] = {
                ...next[r.runId],
                running: r.running,
                exitCode: r.exitCode,
              }
            }
          }
          return next
        })
        return
      }
    }

    window.addEventListener('message', handler)
    // Ask the server for any currently-known runs on first mount — the initial
    // bootstrap replay also sends this, but we're defensive in case the order
    // gets flipped.
    vscode.postMessage({ type: 'listClinicCommands' })
    return () => window.removeEventListener('message', handler)
  }, [])

  const run = useCallback((command: string, args: string = '') => {
    vscode.postMessage({ type: 'runClinicCommand', command, args })
  }, [])

  const cancel = useCallback((runId: string) => {
    vscode.postMessage({ type: 'cancelClinicCommand', runId })
  }, [])

  const runArray = Object.values(runs).sort((a, b) => b.startedAt - a.startedAt)
  const anyRunning = runArray.some((r) => r.running)
  const activeCount = runArray.filter((r) => r.running).length

  return {
    runs: runArray,
    runsById: runs,
    anyRunning,
    activeCount,
    run,
    cancel,
  }
}
