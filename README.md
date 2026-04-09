# pixel-clinic-server

Pixel art clinic visualization server. A multi-agent dashboard that renders a virtual medical clinic where AI agents (intern, chief resident, attending, nurse, etc.) walk between rooms during clinical visits.

Built as the visualization layer for the [SexKit](https://github.com/jmdurant/SexKit) clinical platform — a biometric-guided sexual health app developed under the direction of Dr. James DuRant. Used as a 2D dashboard for Mac browser viewers and as the source-of-truth backend for the [QuestHolodeck](https://github.com/jmdurant/QuestHolodeck) Quest 3 VR clinic renderer.

> Forked from [pixel-agents](https://github.com/pablodelucca/pixel-agents) by Pablo De Lucca (MIT License) and [pixel-agents-standalone](https://github.com/rolandal/pixel-agents-standalone) by Roland Albert. Customized with clinical agent definitions, visit-flow choreography, dump-bootstrap script for embedded clients, and Bonjour publication for multi-device discovery.

![Screenshot](webview-ui/public/Screenshot.jpg)

## What it is

A **Bun/Node WebSocket server** + **React canvas renderer** for a 2D pixel art medical clinic. The server tracks 10 clinic agents (receptionist, intern, chief_resident, attending, admin, therapist/JOY, nurse, hr, it, patient) and broadcasts events as they walk between seats during a visit.

The clinic responds to events from any source:

- **The SexKit iOS app** during a real clinical visit (via HTTP POST fan-out from PixelClinicService)
- **The visit-tuner MCP** when running prompt-engineering visits with Claude/Gemini from Claude Code
- **The Mac browser dashboard** at `http://localhost:3456`
- **A Quest 3 device** (subscribes via WebSocket for the 3D clinic renderer)
- **The `clinic-dev.sh` / `clinic-dev.ps1` dev sender scripts** — fastest way to fire test events during development

The same semantic events drive every renderer — the server is a fan-out hub.

## Quick start

```bash
git clone https://github.com/jmdurant/pixel-clinic-server.git
cd pixel-clinic-server
npm install
cd webview-ui && npm install && cd ..
npm run build
npm start
```

Open `http://localhost:3456` in your browser.

For development (auto-reload on file changes):
```bash
npm run dev
```

## Quest 3 dev workflow

When you're iterating on the Quest 3D renderer in [QuestHolodeck](https://github.com/jmdurant/QuestHolodeck), you don't need to fire real iPhone visits to test every animation tweak. Use this server as your dev sender:

```bash
# Terminal 1: start the server
cd ~/pixel-clinic-server
npm run dev:server

# Terminal 2: fire test events as you iterate
./scripts/clinic-dev.sh visit                   # full 12-15s visit choreography
./scripts/clinic-dev.sh patient_to_exam         # one named flow action
./scripts/clinic-dev.sh move intern cr-chair-visitor  # direct positioning
./scripts/clinic-dev.sh status nurse thinking "Drawing blood"
./scripts/clinic-dev.sh reset                   # send all 10 agents home

# Windows
.\scripts\clinic-dev.ps1 visit
```

The server publishes Bonjour `_pixel-clinic._tcp` so the Quest can auto-discover it via Android NSDManager. No hardcoded IPs.

See [QuestHolodeck/PIXEL_CLINIC_3D.md](https://github.com/jmdurant/QuestHolodeck/blob/main/PIXEL_CLINIC_3D.md) for the full Quest dev pipeline (dual-source ClinicEventBus pattern, NPC controller skeleton, Phase 1 → Phase 4 plan).

## API

### HTTP POST endpoints (event sources fire these)

| Endpoint | Body | When |
|----------|------|------|
| `POST /api/clinic/flow` | `{ "action": "intern_to_chief_resident" }` | Named choreographed move (12 actions) |
| `POST /api/clinic/move` | `{ "agent": "intern", "seatId": "cr-chair-visitor" }` | Direct positioning |
| `POST /api/event` | `{ "agent": "nurse", "status": "thinking", "task": "Drawing blood" }` | Activity state |

### HTTP GET endpoints

| Endpoint | Returns |
|----------|---------|
| `GET /api/clinic/state` | Full snapshot — all agents with currentSeat, assignedSeat, activity |

### WebSocket broadcasts (clients subscribe)

The server pushes these to all connected WebSocket clients:

- `settingsLoaded`, `characterSpritesLoaded`, `wallTilesLoaded`, `existingAgents`, `layoutLoaded` — bootstrap state on connect
- `clinicMoveSeat` — agent moved
- `agentStatus` — agent activity changed
- `agentToolStart` / `agentToolDone` — speech bubble lifecycle
- `agentCreated` / `agentClosed` — agent roster changes

## Bootstrap snapshot for embedded clients

Some clients (like the SexKit iOS app's embedded WKWebView clinic) need to render the clinic standalone, without maintaining a live WebSocket connection to this server. For those, use:

```bash
npm run dump-bootstrap
```

This generates `bootstrap.json` (~546 KB) containing all the messages a normal client would receive at connect time. Embedded clients bundle this file and replay it locally on startup.

To sync into the SexKit iOS app:
```bash
cp bootstrap.json ~/SexKit/SexKit\ iOS\ App/Resources/PixelClinic/bootstrap.json
```

Then commit + rebuild SexKit. See [QuestHolodeck/PIXEL_CLINIC_3D.md](https://github.com/jmdurant/QuestHolodeck/blob/main/PIXEL_CLINIC_3D.md#bootstrap-sync-workflow-cross-repo) for the full sync workflow.

## Clinic agents and seats

10 clinic agents are auto-created at server startup with deterministic IDs:

| Key | Display name | Default seat |
|-----|--------------|--------------|
| `receptionist` | Receptionist | recep-chair |
| `intern` | Clinical Intern | exam1-chair-doc |
| `chief_resident` | Chief Resident | cr-chair |
| `attending` | Attending | att-chair |
| `admin` | Clinical Admin | admin-chair |
| `therapist` | JOY — Therapist | therapy-chair-2 |
| `nurse` | Clinical Nurse | nurse-chair |
| `hr` | HR | hr-chair |
| `it` | IT | it-chair |
| `patient` | Patient | entry-chair-patient |

12 named flow actions cover the standard visit choreography (`patient_to_exam`, `intern_to_chief_resident`, `chief_resident_to_attending`, etc.). Direct moves via `/api/clinic/move` cover anything outside the standard flows.

## Architecture

- **Bun/Node Express server** (`server/index.ts`) — HTTP API + WebSocket fan-out + Bonjour publication
- **React canvas renderer** (`webview-ui/`) — 2D pixel art with NavMesh-based pathfinding, runs in any browser
- **Bonjour service** (`_pixel-clinic._tcp`) — local network auto-discovery for clients (iOS, Quest, Mac browser)
- **Persistence** (`~/.pixel-agents/`) — saved layouts and seat assignments

## Related repos

- **[SexKit](https://github.com/jmdurant/SexKit)** — biometric-guided sexual health iOS/watchOS app. Hosts the iOS embedded clinic (loads `bootstrap.json` from this repo as a build-time snapshot) and the visit-tuner MCP that drives clinic events during prompt engineering.
- **[QuestHolodeck](https://github.com/jmdurant/QuestHolodeck)** — Quest 3 Unity project. Subscribes to this server's WebSocket for the 3D clinic renderer (in development).

## License

MIT. See LICENSE.
