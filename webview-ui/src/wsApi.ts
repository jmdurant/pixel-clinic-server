// Transport API — auto-detects WebSocket (Mac browser) vs iOS WebView bridge.
//
// Two transports, same React build:
//   1. WebSocket — connects to the pixel-agents server (Mac/dev path)
//   2. iOS WebView bridge — uses webkit.messageHandlers.sexkit (iOS app path)
//
// The iOS path is detected at runtime via the presence of webkit.messageHandlers.sexkit,
// which the SexKit iOS app injects when loading the bundled build inside a WKWebView.

const WS_URL = import.meta.env.DEV
  ? "ws://localhost:3456"
  : `ws://${window.location.host}`;

// Detect iOS WebView bridge — Swift injects window.webkit.messageHandlers.sexkit
const isIOSBridge: boolean =
  typeof window !== "undefined" &&
  // @ts-expect-error — webkit is not in standard DOM types
  Boolean(window.webkit?.messageHandlers?.sexkit);

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

export function connectWebSocket(): void {
  if (isIOSBridge) {
    // iOS path — Swift injects events via window.dispatchEvent("message").
    // We just announce ready so Swift can flush any queued state.
    console.log("[wsApi] Using iOS WebView bridge");
    sendMessage({ type: "webviewReady" });
    return;
  }

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("Connected to pixel-agents server");
    ws?.send(JSON.stringify({ type: "webviewReady" }));
  };

  ws.onmessage = (event) => {
    // Dispatch as window message to match upstream useExtensionMessages hook
    const data = JSON.parse(event.data);
    window.dispatchEvent(new MessageEvent("message", { data }));
  };

  ws.onclose = () => {
    console.log("Disconnected, reconnecting in 2s...");
    reconnectTimer = setTimeout(connectWebSocket, 2000);
  };

  ws.onerror = () => ws?.close();
}

export function sendMessage(msg: unknown): void {
  if (isIOSBridge) {
    // @ts-expect-error — webkit is not in standard DOM types
    window.webkit.messageHandlers.sexkit.postMessage(msg);
    return;
  }
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

export function cleanup(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  ws?.close();
}
