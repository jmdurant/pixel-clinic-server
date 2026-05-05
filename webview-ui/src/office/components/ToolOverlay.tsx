import { useState, useEffect } from 'react'
import type { ToolActivity } from '../types.js'
import type { OfficeState } from '../engine/officeState.js'
import type { SubagentCharacter } from '../../hooks/useExtensionMessages.js'
import { TILE_SIZE, CharacterState } from '../types.js'
import { TOOL_OVERLAY_VERTICAL_OFFSET, CHARACTER_SITTING_OFFSET_PX } from '../../constants.js'

interface ToolOverlayProps {
  officeState: OfficeState
  agents: number[]
  agentTools: Record<number, ToolActivity[]>
  subagentCharacters: SubagentCharacter[]
  containerRef: React.RefObject<HTMLDivElement | null>
  zoom: number
  panRef: React.RefObject<{ x: number; y: number }>
  onCloseAgent: (id: number) => void
}

/** Derive a short human-readable activity string from tools/status */
function getActivityText(
  agentId: number,
  agentTools: Record<number, ToolActivity[]>,
  isActive: boolean,
): string {
  const tools = agentTools[agentId]
  if (tools && tools.length > 0) {
    // Find the latest non-done tool
    const activeTool = [...tools].reverse().find((t) => !t.done)
    if (activeTool) {
      if (activeTool.permissionWait) return 'Needs approval'
      return activeTool.status
    }
    // All tools done but agent still active (mid-turn) — keep showing last tool status
    if (isActive) {
      const lastTool = tools[tools.length - 1]
      if (lastTool) return lastTool.status
    }
  }

  return 'Idle'
}

export function ToolOverlay({
  officeState,
  agents,
  agentTools,
  subagentCharacters,
  containerRef,
  zoom,
  panRef,
  onCloseAgent,
}: ToolOverlayProps) {
  const [, setTick] = useState(0)
  useEffect(() => {
    let rafId = 0
    const tick = () => {
      setTick((n) => n + 1)
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [])

  const el = containerRef.current
  if (!el) return null
  const rect = el.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const canvasW = Math.round(rect.width * dpr)
  const canvasH = Math.round(rect.height * dpr)
  const layout = officeState.getLayout()
  const mapW = layout.cols * TILE_SIZE * zoom
  const mapH = layout.rows * TILE_SIZE * zoom
  const deviceOffsetX = Math.floor((canvasW - mapW) / 2) + Math.round(panRef.current.x)
  const deviceOffsetY = Math.floor((canvasH - mapH) / 2) + Math.round(panRef.current.y)

  const selectedId = officeState.selectedAgentId
  const hoveredId = officeState.hoveredAgentId

  // All character IDs
  const allIds = [...agents, ...subagentCharacters.map((s) => s.id)]

  // Pre-compute screen positions + activity state so we can spread
  // bubbles comic-book style. For each cluster of nearby agents we
  // distribute bubbles horizontally (left / center / right of the
  // agent), with a tail pointing back at the speaker. When clusters
  // get dense, we wrap onto a second vertical row.
  const BUBBLE_MAX_WIDTH = 280
  const BUBBLE_HALF_WIDTH = BUBBLE_MAX_WIDTH / 2 + 12
  const BUBBLE_STEP_X = 130    // horizontal spacing between bubbles in a cluster (kept tight so connector lines are short)
  const LANE_HEIGHT = 80       // px when wrapping to a second row
  const BUBBLE_HEIGHT_EST = 56 // approximate rendered bubble height (used to anchor connector lines)

  type Entry = {
    id: number
    ch: NonNullable<ReturnType<OfficeState['characters']['get']>>
    isSelected: boolean
    isHovered: boolean
    isSub: boolean
    activityText: string
    isWorking: boolean
    showDetails: boolean
    dotColor: string | null
    displayName: string
    screenX: number
    screenY: number
    agentScreenY: number  // on-screen Y of character body (for connector endpoint)
    bubbleX: number  // absolute screen X for bubble center
    bubbleY: number  // absolute screen Y for bubble bottom
    tailDx: number   // horizontal offset (px) of tail tip relative to bubble center
  }

  const entries: Entry[] = []
  for (const id of allIds) {
    const ch = officeState.characters.get(id)
    if (!ch) continue
    const isSelected = selectedId === id
    const isHovered = hoveredId === id
    const isSub = ch.isSubagent

    // Compute activity / working status for ALL characters (not just hover/select)
    let activityText = ''
    let dotColor: string | null = null
    let isWorking = false

    const subHasPermission = isSub && ch.bubbleType === 'permission'
    if (isSub) {
      if (subHasPermission) {
        activityText = 'Needs approval'
        isWorking = true
      } else {
        const sub = subagentCharacters.find((s) => s.id === id)
        activityText = sub ? sub.label : 'Subtask'
        isWorking = !!sub
      }
    } else {
      activityText = getActivityText(id, agentTools, ch.isActive)
      isWorking = activityText !== 'Idle'
    }

    const tools = agentTools[id]
    const hasPermission = subHasPermission || tools?.some((t) => t.permissionWait && !t.done)
    const hasActiveTools = tools?.some((t) => !t.done)

    if (hasPermission) {
      dotColor = 'var(--pixel-status-permission)'
    } else if (ch.isActive && hasActiveTools) {
      dotColor = 'var(--pixel-status-active)'
    } else if (isWorking && !isSub) {
      dotColor = 'var(--pixel-status-active)'
    }

    // Show the big bubble whenever the agent is working OR explicitly hovered/selected
    const showDetails = isSelected || isHovered || isWorking

    const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0
    const screenX = (deviceOffsetX + ch.x * zoom) / dpr
    const screenY = (deviceOffsetY + (ch.y + sittingOffset - TOOL_OVERLAY_VERTICAL_OFFSET) * zoom) / dpr
    // Actual on-screen Y of the character body (not the bubble anchor). Used
    // for connector-line endpoints so they land on the character, not above
    // their head.
    const agentScreenY = (deviceOffsetY + (ch.y + sittingOffset) * zoom) / dpr

    const displayName = ch.folderName || (isSub ? 'Subtask' : `Agent #${id}`)
    entries.push({
      id, ch, isSelected, isHovered, isSub, activityText, isWorking, showDetails, dotColor, displayName,
      screenX, screenY, agentScreenY, bubbleX: screenX, bubbleY: screenY - 24, tailDx: 0,
    })
  }

  // Comic-book layout: cluster bubbles by horizontal proximity, then
  // distribute each cluster's bubbles across horizontal slots so they
  // sit beside each other rather than stacked vertically. Tail offsets
  // record how far the bubble drifted from its agent so the speech-tail
  // can point back. Idle (non-expanded) bubbles stay anchored above
  // their character (lane 0, no offset).
  const expanded = entries.filter((e) => e.showDetails)
  expanded.sort((a, b) => a.screenX - b.screenX)
  const clusters: Entry[][] = []
  let cluster: Entry[] = []
  let prevX = -Infinity
  for (const e of expanded) {
    if (e.screenX - prevX < BUBBLE_STEP_X) {
      cluster.push(e)
    } else {
      if (cluster.length > 0) clusters.push(cluster)
      cluster = [e]
    }
    prevX = e.screenX
  }
  if (cluster.length > 0) clusters.push(cluster)
  // Default vertical gap from agent head anchor to bubble bottom.
  // (screenY is already 32 world-units above the character body; we add
  // another 60 screen-px so the bubble sits well above the head with the
  // connector line clearly visible between them.)
  const BUBBLE_REST_OFFSET = 60
  for (const c of clusters) {
    const n = c.length
    const mid = (n - 1) / 2
    c.forEach((e, i) => {
      const xOffset = (i - mid) * BUBBLE_STEP_X
      e.bubbleX = e.screenX + xOffset
      e.tailDx = -xOffset  // tail points back toward agent
      // If the cluster is wider than ~3 bubbles, also stagger vertically
      // so the row doesn't run off the side of the screen.
      if (n > 3 && i % 2 === 1) e.bubbleY = e.screenY - BUBBLE_REST_OFFSET - LANE_HEIGHT
      else e.bubbleY = e.screenY - BUBBLE_REST_OFFSET
    })
  }

  // After horizontal distribution, bubbles can drift over nearby agents
  // who AREN'T the speaker. Push each bubble up by LANE_HEIGHT until its
  // bounding rect is clear of every other character sprite. This trades
  // a slightly taller stack height for never blocking the view of an
  // agent character.
  const AGENT_HALF_W = 16
  const AGENT_HEIGHT_PX = 40   // approx character sprite height
  const NUDGE_PADDING = 8       // extra px between bubble bottom and agent top
  for (const e of entries.filter((x) => x.showDetails)) {
    let safetyIter = 0
    while (safetyIter < 6) {
      const bubbleLeft = e.bubbleX - BUBBLE_HALF_WIDTH
      const bubbleRight = e.bubbleX + BUBBLE_HALF_WIDTH
      const bubbleBottom = e.bubbleY + BUBBLE_HEIGHT_EST
      const bubbleTop = e.bubbleY
      let overlapAgent: Entry | null = null
      for (const other of entries) {
        if (other.id === e.id) continue
        const ax = other.screenX
        const aTop = other.agentScreenY - AGENT_HEIGHT_PX
        const aBot = other.agentScreenY
        const aLeft = ax - AGENT_HALF_W
        const aRight = ax + AGENT_HALF_W
        const xOverlap = bubbleLeft < aRight && bubbleRight > aLeft
        const yOverlap = bubbleTop < aBot && bubbleBottom > aTop
        if (xOverlap && yOverlap) {
          overlapAgent = other
          break
        }
      }
      if (!overlapAgent) break
      // Lift bubble so its bottom sits above the offending agent's head.
      // Use Math.min so we only ever move UP (smaller Y); never accidentally
      // lower the bubble below its current position.
      const aTop = overlapAgent.agentScreenY - AGENT_HEIGHT_PX
      const lifted = aTop - BUBBLE_HEIGHT_EST - NUDGE_PADDING
      if (lifted >= e.bubbleY) break  // already above this agent
      e.bubbleY = lifted
      safetyIter += 1
    }
  }

  return (
    <>
      {/* Connector lines from each speaking agent to their bubble.
          Drawn as a single SVG layered over the whole overlay so we can
          render lines in absolute screen coords (bubbles use percent-
          based transforms, which makes per-bubble SVG awkward). */}
      <svg
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          overflow: 'visible',
          zIndex: 'var(--pixel-overlay-z)',
        }}
        aria-hidden
      >
        {entries.filter((e) => e.showDetails).map((e) => {
          const stroke = e.isSelected ? 'var(--pixel-border-light)' : 'var(--pixel-border)'
          // Line: from the agent's head (just below the bubble's hover
          // anchor) down to the bubble's bottom edge.
          const x1 = e.screenX
          const y1 = e.screenY + 8
          const x2 = e.bubbleX
          const y2 = e.bubbleY + BUBBLE_HEIGHT_EST
          return (
            <line
              key={e.id}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={stroke}
              strokeWidth={2}
            />
          )
        })}
      </svg>
      {entries.map((e) => {
        const { id, ch, isSelected, isHovered: _isHovered, isSub, activityText, showDetails, dotColor, displayName, screenX, screenY, bubbleX, bubbleY, tailDx } = e

        return (
          <div
            key={id}
            style={{
              position: 'absolute',
              left: bubbleX,
              top: bubbleY,
              transform: 'translateX(-50%)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              pointerEvents: isSelected ? 'auto' : 'none',
              // Active speech bubbles must render above idle name pills so a
              // working agent's bubble that's been shifted horizontally covers
              // any other agent's idle pill it drifts over.
              zIndex: isSelected
                ? 'var(--pixel-overlay-selected-z)'
                : (showDetails ? 105 : 90),
            }}
          >
            {showDetails ? (
              <div
                style={{
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 6,
                  background: 'var(--pixel-bg)',
                  border: isSelected
                    ? '2px solid var(--pixel-border-light)'
                    : '2px solid var(--pixel-border)',
                  borderRadius: 0,
                  padding: '6px 10px',
                  boxShadow: 'var(--pixel-shadow)',
                  maxWidth: BUBBLE_MAX_WIDTH,
                  minWidth: 140,
                }}
              >
                {/* Tail pointing back to the agent. Clamp horizontally so it
                    stays under the bubble even when the offset is large. */}
                <span
                  aria-hidden
                  style={{
                    position: 'absolute',
                    bottom: -10,
                    left: `calc(50% + ${Math.max(-90, Math.min(90, tailDx))}px)`,
                    width: 0,
                    height: 0,
                    transform: 'translateX(-50%)',
                    borderLeft: '8px solid transparent',
                    borderRight: '8px solid transparent',
                    borderTop: `10px solid ${isSelected ? 'var(--pixel-border-light)' : 'var(--pixel-border)'}`,
                  }}
                />
                <span
                  aria-hidden
                  style={{
                    position: 'absolute',
                    bottom: -7,
                    left: `calc(50% + ${Math.max(-90, Math.min(90, tailDx))}px)`,
                    width: 0,
                    height: 0,
                    transform: 'translateX(-50%)',
                    borderLeft: '6px solid transparent',
                    borderRight: '6px solid transparent',
                    borderTop: '8px solid var(--pixel-bg)',
                  }}
                />
                {dotColor && (
                  <span
                    className={ch.isActive && dotColor !== 'var(--pixel-status-permission)' ? 'pixel-agents-pulse' : undefined}
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: dotColor,
                      flexShrink: 0,
                      marginTop: 6,
                    }}
                  />
                )}
                <div style={{ overflow: 'hidden', flex: 1 }}>
                  <span
                    style={{
                      fontSize: isSub ? '20px' : '22px',
                      fontStyle: isSub ? 'italic' : undefined,
                      fontWeight: 600,
                      color: 'var(--vscode-foreground)',
                      display: 'block',
                      lineHeight: 1.2,
                      whiteSpace: 'normal',
                      wordBreak: 'break-word',
                    }}
                  >
                    {activityText}
                  </span>
                  <span
                    style={{
                      fontSize: '14px',
                      color: 'var(--pixel-text-dim)',
                      display: 'block',
                      marginTop: 2,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {displayName}
                  </span>
                </div>
                {isSelected && !isSub && (
                  <button
                    onClick={(ev) => {
                      ev.stopPropagation()
                      onCloseAgent(id)
                    }}
                    title="Close agent"
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--pixel-close-text)',
                      cursor: 'pointer',
                      padding: '0 2px',
                      fontSize: '26px',
                      lineHeight: 1,
                      marginLeft: 2,
                      flexShrink: 0,
                    }}
                    onMouseEnter={(ev) => {
                      (ev.currentTarget as HTMLElement).style.color = 'var(--pixel-close-hover)'
                    }}
                    onMouseLeave={(ev) => {
                      (ev.currentTarget as HTMLElement).style.color = 'var(--pixel-close-text)'
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            ) : (
              <div
                style={{
                  background: 'var(--pixel-bg)',
                  border: '1px solid var(--pixel-border)',
                  padding: '1px 6px',
                  boxShadow: 'var(--pixel-shadow)',
                  whiteSpace: 'nowrap',
                }}
              >
                <span
                  style={{
                    fontSize: '16px',
                    color: 'var(--pixel-text-dim)',
                  }}
                >
                  {displayName}
                </span>
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}
