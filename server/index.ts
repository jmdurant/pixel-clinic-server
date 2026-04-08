import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { JsonlWatcher, type WatchedFile } from "./watcher.js";
import { processTranscriptLine } from "./parser.js";
import {
  loadCharacterSprites,
  loadWallTiles,
  loadFloorTiles,
  loadFurnitureAssets,
  loadDefaultLayout,
} from "./assetLoader.js";
import type { TrackedAgent, ServerMessage } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3456", 10);
const IDLE_SHUTDOWN_MS = 600_000; // 10 minutes

// State
const agents = new Map<string, TrackedAgent>(); // sessionId -> agent
let nextAgentId = 1;
const clients = new Set<WebSocket>();
let lastActivityTime = Date.now();

// Load assets at startup
// In dev mode (tsx), __dirname is server/ so assets are at ../webview-ui/public/assets/
// In production (esbuild), __dirname is dist/ so assets are at ./public/assets/
const devAssetsRoot = join(__dirname, "..", "webview-ui", "public", "assets");
const prodAssetsRoot = join(__dirname, "public", "assets");
const assetsRoot = existsSync(devAssetsRoot) ? devAssetsRoot : prodAssetsRoot;

console.log(`[Server] Loading assets from: ${assetsRoot}`);

const characterSprites = loadCharacterSprites(assetsRoot);
const wallTiles = loadWallTiles(assetsRoot);
const floorTiles = loadFloorTiles(assetsRoot);
const furnitureAssets = loadFurnitureAssets(assetsRoot);

// Persistence directory
const persistDir = join(homedir(), ".pixel-agents");
const persistedLayoutPath = join(persistDir, "layout.json");
const persistedSeatsPath = join(persistDir, "agent-seats.json");

// Load layout: persisted first, then default
function loadLayout(): Record<string, unknown> | null {
  if (existsSync(persistedLayoutPath)) {
    try {
      const content = readFileSync(persistedLayoutPath, "utf-8");
      const layout = JSON.parse(content) as Record<string, unknown>;
      console.log(`[Server] Loaded persisted layout from ${persistedLayoutPath}`);
      return layout;
    } catch (err) {
      console.warn(`[Server] Failed to load persisted layout: ${err instanceof Error ? err.message : err}`);
    }
  }
  return loadDefaultLayout(assetsRoot);
}

function loadPersistedSeats(): Record<number, { palette: number; hueShift: number; seatId: string | null }> | null {
  if (existsSync(persistedSeatsPath)) {
    try {
      const content = readFileSync(persistedSeatsPath, "utf-8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
  return null;
}

let currentLayout = loadLayout();

// ── Clinic agent definitions (must be before initClinicAgents) ──
const CLINIC_AGENTS: Record<string, { name: string; id: number }> = {};
const CLINIC_AGENT_NAMES: Record<string, string> = {
  receptionist: "Receptionist",
  intern: "Clinical Intern",
  chief_resident: "Chief Resident",
  attending: "Attending",
  admin: "Clinical Admin",
  therapist: "JOY — Therapist",
  nurse: "Clinical Nurse",
  hr: "HR",
  it: "IT",
};
const CLINIC_SEATS: Record<string, { palette: number; hueShift: number; seatId: string }> = {
  receptionist: { palette: 0, hueShift: 180, seatId: "recep-chair" },
  intern:       { palette: 1, hueShift: 300, seatId: "exam1-chair-doc" },
  chief_resident: { palette: 2, hueShift: 90, seatId: "cr-chair" },       // top-right (split from admin)
  attending:    { palette: 2, hueShift: 120, seatId: "att-chair" },       // bottom-left
  admin:        { palette: 3, hueShift: 45,  seatId: "admin-chair" },    // top-right (across from exams)
  therapist:    { palette: 5, hueShift: 330, seatId: "therapy-chair-2" },
  nurse:        { palette: 1, hueShift: 60,  seatId: "nurse-chair" },        // bottom-center
  hr:           { palette: 3, hueShift: 270, seatId: "hr-chair" },          // bottom-left (HR room)
  it:           { palette: 0, hueShift: 190, seatId: "it-chair" },          // bottom-right (IT room)
  patient:      { palette: 4, hueShift: 200, seatId: "entry-chair-patient" },
};

// Init clinic agents FIRST (writes seats file), then load seats
initClinicAgents();
const persistedSeats = loadPersistedSeats();
console.log(`[Server] Persisted seats:`, persistedSeats ? Object.keys(persistedSeats).map(k => `${k}→${(persistedSeats as any)[k].seatId}`) : 'none');

// Express app
const app = express();
// Serve production build
app.use(express.static(join(__dirname, "public")));

// ── SexKit Clinic API ──
// Accepts events from the visit-tuner MCP to create/update clinic agents
app.use(express.json());

app.post("/api/event", (req, res) => {
  const { agent: agentKey, status, task, message } = req.body;
  if (!agentKey) return res.status(400).json({ error: "missing agent" });

  lastActivityTime = Date.now();

  // Create agent if it doesn't exist
  if (!CLINIC_AGENTS[agentKey]) {
    const id = nextAgentId++;
    const projectName = CLINIC_AGENT_NAMES[agentKey] || agentKey;
    const sessionId = `clinic-${agentKey}`;

    const trackedAgent: TrackedAgent = {
      id,
      sessionId,
      projectDir: "/sexkit-clinic",
      projectName,
      jsonlFile: "",
      fileOffset: 0,
      lineBuffer: "",
      activity: "idle",
      activeTools: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      lastActivityTime: Date.now(),
    };

    agents.set(sessionId, trackedAgent);
    CLINIC_AGENTS[agentKey] = { name: projectName, id };
    broadcast({ type: "agentCreated", id, folderName: projectName });
    console.log(`[Clinic] Agent ${id} created: ${projectName}`);
  }

  const clinicAgent = CLINIC_AGENTS[agentKey];
  const tracked = agents.get(`clinic-${agentKey}`);
  if (!tracked) return res.status(500).json({ error: "agent not found" });

  // Update activity
  const activity = status === "thinking" ? "typing" : status === "talking" ? "reading" : "idle";
  tracked.activity = activity;
  tracked.lastActivityTime = Date.now();

  if (status === "thinking" && task) {
    // Show as tool use (appears as speech bubble)
    const toolId = `clinic-${Date.now()}`;
    broadcast({ type: "agentToolStart", id: clinicAgent.id, toolId, status: task });
    // Auto-clear after a moment
    setTimeout(() => {
      broadcast({ type: "agentToolDone", id: clinicAgent.id, toolId });
    }, 2000);
  }

  if (status === "idle") {
    broadcast({ type: "agentToolsClear", id: clinicAgent.id });
  }

  broadcast({ type: "agentStatus", id: clinicAgent.id, status: activity });

  res.json({ ok: true, id: clinicAgent.id });
});

// Auto-create clinic agents at server startup (before any UI connects).
// Agents are added to the Map silently — NO agentCreated broadcast.
// They show up via sendInitialData → existingAgents when UI connects,
// with seat assignments from the persisted seats file.
function initClinicAgents() {
  const allAgents = { ...CLINIC_AGENT_NAMES, patient: "Patient" };
  const seatsPath = join(homedir(), ".pixel-agents", "agent-seats.json");
  const seatAssignments: Record<number, { palette: number; hueShift: number; seatId: string | null }> = {};

  for (const [key, name] of Object.entries(allAgents)) {
    if (!CLINIC_AGENTS[key]) {
      const id = nextAgentId++;
      const sessionId = `clinic-${key}`;
      const trackedAgent: TrackedAgent = {
        id, sessionId, projectDir: "/sexkit-clinic", projectName: name,
        jsonlFile: "", fileOffset: 0, lineBuffer: "", activity: "idle",
        activeTools: new Map(), activeToolNames: new Map(),
        activeSubagentToolIds: new Map(), activeSubagentToolNames: new Map(),
        isWaiting: false, permissionSent: false, hadToolsInTurn: false,
        lastActivityTime: Date.now(),
      };
      agents.set(sessionId, trackedAgent);
      CLINIC_AGENTS[key] = { name, id };
      console.log(`[Clinic] Created agent ${id}: ${name}`);
    }

    const seat = CLINIC_SEATS[key];
    if (seat) seatAssignments[CLINIC_AGENTS[key].id] = seat;
  }

  // Write seat assignments BEFORE any UI connects
  try {
    mkdirSync(join(homedir(), ".pixel-agents"), { recursive: true });
    writeFileSync(seatsPath, JSON.stringify(seatAssignments, null, 2));
    console.log(`[Clinic] Wrote seat assignments: ${JSON.stringify(seatAssignments)}`);
  } catch (err) {
    console.error(`[Clinic] Failed to write seats: ${err}`);
  }
}

// initClinicAgents() already called above (before loadPersistedSeats)

// Also expose as API for re-init
app.post("/api/clinic/init", (_req, res) => {
  initClinicAgents();
  res.json({ ok: true, agents: CLINIC_AGENTS });
});

// Keep clinic agents seated (prevent wandering) — called after UI loads
app.post("/api/clinic/lock-seats", (_req, res) => {
  for (const [key, agent] of Object.entries(CLINIC_AGENTS)) {
    broadcast({ type: "clinicSetActive", id: agent.id, active: true } as any);
  }
  res.json({ ok: true });
});

// Move any clinic agent to a specific seat (with walking animation)
app.post("/api/clinic/move", (req, res) => {
  const { agent: agentKey, seatId } = req.body;
  const key = agentKey || "patient";
  const clinicAgent = CLINIC_AGENTS[key];
  if (!clinicAgent) return res.status(400).json({ error: `agent '${key}' not initialized` });

  // Broadcast clinicMoveSeat — the UI's useExtensionMessages handler
  // calls officeState.reassignSeat() which pathfinds and walks the character
  broadcast({ type: "clinicMoveSeat", id: clinicAgent.id, seatId } as any);
  console.log(`[Clinic] Moving ${key} (id=${clinicAgent.id}) to seat ${seatId}`);

  res.json({ ok: true, agentId: clinicAgent.id, seatId });
});

// Clinical flow routes — named moves for the visit lifecycle
app.post("/api/clinic/flow", (req, res) => {
  const { action } = req.body;

  // Named flow actions map to agent moves
  const flows: Record<string, { agent: string; seatId: string; description: string }> = {
    // Intern presents to Chief Resident
    "intern_to_chief_resident": { agent: "intern", seatId: "cr-chair-visitor", description: "Intern walks to Chief Resident to present findings" },
    "intern_to_attending": { agent: "intern", seatId: "att-chair-visitor", description: "Intern walks to Attending to present (no chief resident configured)" },
    "intern_return": { agent: "intern", seatId: "exam1-chair-doc", description: "Intern returns to exam room" },
    // Chief Resident presents to Attending
    "chief_resident_to_attending": { agent: "chief_resident", seatId: "att-chair-visitor", description: "Chief Resident walks to Attending office to present" },
    "chief_resident_return": { agent: "chief_resident", seatId: "cr-chair", description: "Chief Resident returns to office" },
    // Chief Resident talks to Patient
    "chief_resident_to_patient": { agent: "chief_resident", seatId: "entry-chair-patient", description: "Chief Resident walks to patient" },
    // Attending talks to Patient
    "attending_to_patient": { agent: "attending", seatId: "entry-chair-patient", description: "Attending walks to patient" },
    "attending_return": { agent: "attending", seatId: "att-chair", description: "Attending returns to office" },
    // Patient flow
    "patient_to_nurse": { agent: "patient", seatId: "nurse-chair", description: "Patient walks to Nurse station" },
    "patient_to_exam": { agent: "patient", seatId: "exam1-chair-patient", description: "Patient walks to exam room" },
    "patient_to_therapy": { agent: "patient", seatId: "therapy-chair-1", description: "Patient walks to therapy room" },
    "patient_to_exit": { agent: "patient", seatId: "entry-chair-patient", description: "Patient returns to entrance" },
  };

  if (!action) {
    return res.json({ ok: true, available_actions: Object.keys(flows) });
  }

  const flow = flows[action];
  if (!flow) return res.status(400).json({ error: `unknown action '${action}'`, available: Object.keys(flows) });

  const clinicAgent = CLINIC_AGENTS[flow.agent];
  if (!clinicAgent) return res.status(400).json({ error: `agent '${flow.agent}' not initialized` });

  broadcast({ type: "clinicMoveSeat", id: clinicAgent.id, seatId: flow.seatId } as any);
  console.log(`[Clinic Flow] ${action}: ${flow.description}`);

  res.json({ ok: true, action, ...flow, agentId: clinicAgent.id });
});

// Validate all paths between clinic seats — finds blocked corridors
app.get("/api/clinic/validate-paths", (_req, res) => {
  const seatIds = Object.values(CLINIC_SEATS).map(s => s.seatId);
  const results: Array<{ from: string; to: string; status: string; steps?: number }> = [];

  // Test pathfinding between every pair of clinic seats
  // We do this by asking the UI via a special broadcast + collecting results
  // For now, return the seat positions so we can debug
  const seatPositions: Record<string, string> = {};
  for (const [key, seat] of Object.entries(CLINIC_SEATS)) {
    seatPositions[key] = seat.seatId;
  }

  res.json({
    ok: true,
    seats: seatPositions,
    note: "Use /api/clinic/test-path?from=SEAT&to=SEAT to test specific paths",
  });
});

// Validate ALL paths between clinic seats
app.post("/api/clinic/validate-all", (_req, res) => {
  const seatIds = Object.values(CLINIC_SEATS).map(s => s.seatId);
  // Test every pair
  for (let i = 0; i < seatIds.length; i++) {
    for (let j = i + 1; j < seatIds.length; j++) {
      broadcast({ type: "clinicTestPath", fromSeat: seatIds[i], toSeat: seatIds[j] } as any);
    }
  }
  console.log(`[Clinic] Testing ${seatIds.length * (seatIds.length - 1) / 2} paths`);
  res.json({ ok: true, pairs: seatIds.length * (seatIds.length - 1) / 2, note: "Check browser console for results" });
});

// Test a specific path between two seats
app.post("/api/clinic/test-path", (req, res) => {
  const { from, to } = req.body;
  if (!from || !to) return res.status(400).json({ error: "provide 'from' and 'to' seat IDs" });

  // Broadcast a test-path request — the UI will run findPath and log the result
  broadcast({ type: "clinicTestPath", fromSeat: from, toSeat: to } as any);
  console.log(`[Clinic] Testing path: ${from} → ${to}`);

  res.json({ ok: true, from, to, note: "Check browser console for path result" });
});

const server = createServer(app);

// WebSocket
const wss = new WebSocketServer({ server });

// Ping/pong heartbeat — keeps clients Set accurate for shutdown guard
const HEARTBEAT_INTERVAL_MS = 30_000;
setInterval(() => {
  for (const ws of clients) {
    if ((ws as unknown as Record<string, boolean>).__isAlive === false) {
      clients.delete(ws);
      ws.terminate();
      continue;
    }
    (ws as unknown as Record<string, boolean>).__isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

function broadcast(msg: ServerMessage): void {
  const data = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function sendInitialData(ws: WebSocket): void {
  // Send settings
  ws.send(JSON.stringify({ type: "settingsLoaded", soundEnabled: false }));

  // Send character sprites
  if (characterSprites) {
    ws.send(JSON.stringify({ type: "characterSpritesLoaded", characters: characterSprites.characters }));
  }

  // Send wall tiles
  if (wallTiles) {
    ws.send(JSON.stringify({ type: "wallTilesLoaded", sprites: wallTiles.sprites }));
  }

  // Send floor tiles (optional)
  if (floorTiles) {
    ws.send(JSON.stringify({ type: "floorTilesLoaded", sprites: floorTiles.sprites }));
  }

  // Send furniture assets (optional)
  if (furnitureAssets) {
    ws.send(
      JSON.stringify({
        type: "furnitureAssetsLoaded",
        catalog: furnitureAssets.catalog,
        sprites: furnitureAssets.sprites,
      }),
    );
  }

  // Send existing agents with seat metadata
  // Clinic agents always use CLINIC_SEATS (overrides persisted file which UI may clobber)
  const clinicSeatsByAgentId = new Map<number, { palette: number; hueShift: number; seatId: string }>();
  for (const [key, seat] of Object.entries(CLINIC_SEATS)) {
    const ca = CLINIC_AGENTS[key];
    if (ca) clinicSeatsByAgentId.set(ca.id, seat);
  }

  const agentList = Array.from(agents.values());
  const agentIds = agentList.map((a) => a.id);
  const folderNames: Record<number, string> = {};
  const agentMeta: Record<number, { palette?: number; hueShift?: number; seatId?: string }> = {};
  for (const a of agentList) {
    folderNames[a.id] = a.projectName;
    // Clinic agents: always use defined seats (immune to UI overwrite)
    const clinicSeat = clinicSeatsByAgentId.get(a.id);
    if (clinicSeat) {
      agentMeta[a.id] = clinicSeat;
    } else if (persistedSeats?.[a.id]) {
      const s = persistedSeats[a.id];
      agentMeta[a.id] = { palette: s.palette, hueShift: s.hueShift, seatId: s.seatId ?? undefined };
    }
  }
  ws.send(JSON.stringify({ type: "existingAgents", agents: agentIds, folderNames, agentMeta }));

  // Send layout (must come after existingAgents — the hook buffers agents until layout arrives)
  if (currentLayout) {
    ws.send(JSON.stringify({ type: "layoutLoaded", layout: currentLayout, version: 1 }));
  } else {
    // Send null layout to trigger default layout creation in the UI
    ws.send(JSON.stringify({ type: "layoutLoaded", layout: null, version: 0 }));
  }
}

wss.on("connection", (ws) => {
  (ws as unknown as Record<string, boolean>).__isAlive = true;
  ws.on("pong", () => { (ws as unknown as Record<string, boolean>).__isAlive = true; });
  clients.add(ws);

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "webviewReady" || msg.type === "ready") {
        sendInitialData(ws);
        // Lock clinic agents to their seats after UI loads (prevent wandering)
        // Send multiple times to ensure it takes effect after layout + agents are ready
        for (const delay of [1000, 3000, 5000]) {
          setTimeout(() => {
            for (const agent of Object.values(CLINIC_AGENTS)) {
              ws.send(JSON.stringify({ type: "clinicSetActive", id: agent.id, active: true }));
            }
            // Hide SexKit (Claude Code) character — not part of the clinic scene
            for (const [sessionId, tracked] of agents) {
              if (!sessionId.startsWith("clinic-")) {
                ws.send(JSON.stringify({ type: "agentClosed", id: tracked.id }));
              }
            }
          }, delay);
        }
      } else if (msg.type === "saveLayout") {
        try {
          mkdirSync(persistDir, { recursive: true });
          writeFileSync(persistedLayoutPath, JSON.stringify(msg.layout, null, 2));
          currentLayout = msg.layout as Record<string, unknown>;
          // Broadcast to other clients for multi-tab sync
          const data = JSON.stringify({ type: "layoutLoaded", layout: msg.layout, version: 1 });
          for (const client of clients) {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(data);
            }
          }
        } catch (err) {
          console.error(`[Server] Failed to save layout: ${err instanceof Error ? err.message : err}`);
        }
      } else if (msg.type === "saveAgentSeats") {
        try {
          mkdirSync(persistDir, { recursive: true });
          writeFileSync(persistedSeatsPath, JSON.stringify(msg.seats, null, 2));
        } catch (err) {
          console.error(`[Server] Failed to save agent seats: ${err instanceof Error ? err.message : err}`);
        }
      }
    } catch {
      /* ignore invalid messages */
    }
  });

  ws.on("close", () => clients.delete(ws));
});

// Watcher
const watcher = new JsonlWatcher();

watcher.on("fileAdded", (file: WatchedFile) => {
  if (agents.has(file.sessionId)) return;
  lastActivityTime = Date.now();

  const agent: TrackedAgent = {
    id: nextAgentId++,
    sessionId: file.sessionId,
    projectDir: dirname(file.path),
    projectName: file.projectName,
    jsonlFile: file.path,
    fileOffset: 0,
    lineBuffer: "",
    activity: "idle",
    activeTools: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastActivityTime: Date.now(),
  };

  agents.set(file.sessionId, agent);
  broadcast({ type: "agentCreated", id: agent.id, folderName: agent.projectName });
  console.log(`Agent ${agent.id} joined: ${agent.projectName} (${file.sessionId.slice(0, 8)})`);
});

watcher.on("fileRemoved", (file: WatchedFile) => {
  const agent = agents.get(file.sessionId);
  if (!agent) return;

  agents.delete(file.sessionId);
  broadcast({ type: "agentClosed", id: agent.id });
  console.log(`Agent ${agent.id} left: ${agent.projectName}`);
});

watcher.on("line", (file: WatchedFile, line: string) => {
  const agent = agents.get(file.sessionId);
  if (!agent) return;
  lastActivityTime = Date.now();

  processTranscriptLine(line, agent, broadcast);
});

// Start
watcher.start();
server.listen(PORT, () => {
  console.log(`Pixel Agents server running at http://localhost:${PORT}`);
  console.log(`Watching ~/.claude/projects/ for active sessions...`);
});

// Idle shutdown
setInterval(() => {
  if (agents.size === 0 && clients.size === 0 && Date.now() - lastActivityTime > IDLE_SHUTDOWN_MS) {
    console.log("No active sessions or clients for 10 minutes, shutting down...");
    watcher.stop();
    server.close();
    process.exit(0);
  }
}, 30_000);

// Graceful shutdown
process.on("SIGINT", () => {
  watcher.stop();
  server.close();
  process.exit(0);
});
