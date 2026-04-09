// dump-bootstrap.ts
// Generates a bootstrap.json file containing all the WebSocket messages the
// clinic-dashboard server would normally send to a freshly-connected client
// (settingsLoaded, characterSpritesLoaded, wallTilesLoaded, floorTilesLoaded,
// furnitureAssetsLoaded, existingAgents, layoutLoaded).
//
// This lets the SexKit iOS app embed the pixel clinic without requiring the
// Mac-hosted Bun server to be reachable. The iOS app loads this JSON at
// runtime, replays the messages through its WKWebView bridge, and the React
// app initializes exactly as if it had connected to a live server.
//
// Run from the clinic-dashboard directory:
//   tsx scripts/dump-bootstrap.ts
//
// Output: bootstrap.json next to package.json — copy into the iOS app's
// Resources/PixelClinic/ folder.

import { writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  loadCharacterSprites,
  loadWallTiles,
  loadFloorTiles,
  loadFurnitureAssets,
  loadDefaultLayout,
} from "../server/assetLoader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const assetsRoot = existsSync(join(repoRoot, "webview-ui/public/assets"))
  ? join(repoRoot, "webview-ui/public/assets")
  : join(repoRoot, "dist/public/assets");

console.log(`[dump-bootstrap] Loading assets from: ${assetsRoot}`);

// Mirror the agent definitions and seat assignments from server/index.ts.
// These need to stay in sync if the server adds new clinic agents.
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
  patient: "Patient",
};

const CLINIC_SEATS: Record<string, { palette: number; hueShift: number; seatId: string }> = {
  receptionist:   { palette: 0, hueShift: 180, seatId: "recep-chair" },
  intern:         { palette: 1, hueShift: 300, seatId: "exam1-chair-doc" },
  chief_resident: { palette: 2, hueShift:  90, seatId: "cr-chair" },
  attending:      { palette: 2, hueShift: 120, seatId: "att-chair" },
  admin:          { palette: 3, hueShift:  45, seatId: "admin-chair" },
  therapist:      { palette: 5, hueShift: 330, seatId: "therapy-chair-2" },
  nurse:          { palette: 1, hueShift:  60, seatId: "nurse-chair" },
  hr:             { palette: 3, hueShift: 270, seatId: "hr-chair" },
  it:             { palette: 0, hueShift: 190, seatId: "it-chair" },
  patient:        { palette: 4, hueShift: 200, seatId: "entry-chair-patient" },
};

// Load all assets
const characterSprites = loadCharacterSprites(assetsRoot);
const wallTiles = loadWallTiles(assetsRoot);
const floorTiles = loadFloorTiles(assetsRoot);
const furnitureAssets = loadFurnitureAssets(assetsRoot);
const layout = loadDefaultLayout(assetsRoot);

console.log(`[dump-bootstrap] characterSprites=${characterSprites ? "OK" : "MISSING"}`);
console.log(`[dump-bootstrap] wallTiles=${wallTiles ? "OK" : "MISSING"}`);
console.log(`[dump-bootstrap] floorTiles=${floorTiles ? "OK" : "MISSING"}`);
console.log(`[dump-bootstrap] furnitureAssets=${furnitureAssets ? "OK" : "MISSING"}`);
console.log(`[dump-bootstrap] layout=${layout ? "OK" : "MISSING"}`);

// Build agent metadata in the same shape sendInitialData produces.
// Without a running server we can't know "live" agents — we synthesize the
// 10 clinic agents with deterministic IDs (1-10) so the React app sees them
// as if they were created by the server's initClinicAgents() function.
const agentKeys = Object.keys(CLINIC_AGENT_NAMES);
const folderNames: Record<number, string> = {};
const agentMeta: Record<number, { palette: number; hueShift: number; seatId: string }> = {};
const agentIds: number[] = [];

agentKeys.forEach((key, index) => {
  const id = index + 1;
  agentIds.push(id);
  folderNames[id] = CLINIC_AGENT_NAMES[key];
  agentMeta[id] = CLINIC_SEATS[key];
});

// Build the messages — these match the JSON shapes sendInitialData sends over WS
const messages: unknown[] = [];

messages.push({ type: "settingsLoaded", soundEnabled: false });

if (characterSprites) {
  messages.push({ type: "characterSpritesLoaded", characters: characterSprites.characters });
}
if (wallTiles) {
  messages.push({ type: "wallTilesLoaded", sprites: wallTiles.sprites });
}
if (floorTiles) {
  messages.push({ type: "floorTilesLoaded", sprites: floorTiles.sprites });
}
if (furnitureAssets) {
  messages.push({
    type: "furnitureAssetsLoaded",
    catalog: furnitureAssets.catalog,
    sprites: furnitureAssets.sprites,
  });
}

messages.push({ type: "existingAgents", agents: agentIds, folderNames, agentMeta });

if (layout) {
  messages.push({ type: "layoutLoaded", layout, version: 1 });
} else {
  messages.push({ type: "layoutLoaded", layout: null, version: 0 });
}

// Lock the clinic agents to their seats (matches the server's lock-seats burst
// that fires after webviewReady — without it agents can wander).
for (const id of agentIds) {
  messages.push({ type: "clinicSetActive", id, active: true });
}

// Write the bootstrap file
const outPath = join(repoRoot, "bootstrap.json");
const json = JSON.stringify(messages);
writeFileSync(outPath, json);

const sizeKB = Math.round(Buffer.byteLength(json, "utf8") / 1024);
console.log(`[dump-bootstrap] Wrote ${messages.length} messages to ${outPath} (${sizeKB} KB)`);
