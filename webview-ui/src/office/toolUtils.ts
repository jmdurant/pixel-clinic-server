/** Map status prefixes back to tool names for animation selection */
export const STATUS_TO_TOOL: Record<string, string> = {
  'Reading': 'Read',
  'Searching': 'Grep',
  'Globbing': 'Glob',
  'Fetching': 'WebFetch',
  'Searching web': 'WebSearch',
  'Writing': 'Write',
  'Editing': 'Edit',
  'Running': 'Bash',
  'Task': 'Task',
}

export function extractToolName(status: string): string | null {
  for (const [prefix, tool] of Object.entries(STATUS_TO_TOOL)) {
    if (status.startsWith(prefix)) return tool
  }
  const first = status.split(/[\s:]/)[0]
  return first || null
}

import { ZOOM_DEFAULT_DPR_FACTOR, ZOOM_MIN } from '../constants.js'

/** Compute a default integer zoom level (device pixels per sprite pixel) */
export function defaultZoom(): number {
  // iOS WKWebView bridge mode: the SexKit iOS app embeds this React build inside
  // a WKWebView, where devicePixelRatio is 2-3 on Retina/Super Retina displays.
  // The default formula (factor × dpr) produces a too-large zoom there. Use a
  // smaller fixed default in bridge mode so the clinic fits the iPhone screen.
  // Detection matches wsApi.ts — webkit.messageHandlers.sexkit is only injected
  // by the iOS app's WKWebView config.
  const isIOSBridge =
    typeof window !== 'undefined' &&
    // @ts-expect-error — webkit not in standard DOM types
    Boolean(window.webkit?.messageHandlers?.sexkit)
  if (isIOSBridge) {
    // Fixed default of 3 — fits the iPhone screen comfortably without
    // overflowing. Zoom 1 is too small, zoom 4+ is too large. User can still
    // adjust via the on-screen controls.
    return 3
  }
  const dpr = window.devicePixelRatio || 1
  return Math.max(ZOOM_MIN, Math.round(ZOOM_DEFAULT_DPR_FACTOR * dpr))
}
