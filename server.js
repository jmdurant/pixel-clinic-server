#!/usr/bin/env bun
/**
 * SexKit Clinic Dashboard — Multi-Agent Orchestrator + Pixel Art Visualization
 *
 * Runs a web server that:
 * 1. Serves the pixel art clinic UI
 * 2. Orchestrates multiple AI agents (receptionist, intern, attending, admin)
 * 3. Connects to SexKit MCP on iPhone for tool execution
 * 4. Streams agent state to the browser via WebSocket
 */

const SEXKIT_MCP_URL = "http://localhost:8081/mcp";
const PORT = 3333;

// ── Agent Definitions ──

const AGENTS = {
  receptionist: {
    name: "JOY — Receptionist",
    model: "claude-haiku-4-5-20251001",
    color: "#00bcd4",
    desk: { x: 2, y: 1 },
    status: "idle",
    allowedTools: ["schedule_workout", "reschedule_workout", "cancel_workout", "get_free_time", "list_schedule", "prompt_user"],
    systemPrompt: `You are JOY, the front desk receptionist at a medical clinic. Greet patients warmly. Verify demographics (name, DOB, phone, address). Collect insurance (carrier, member ID, group). Get brief reason for visit. Route to correct specialty:
- Chest pain/palpitations → Cardiology
- Mood/anxiety/depression/ADHD → Psychiatry
- Skin rash/mole → Dermatology
- Joint/back pain → Orthopedics
- Stomach/bowel issues → GI
- Sexual health/PE/ED → Sexual Health
- General/wellness → Primary Care
You do NOT give medical advice. If emergency, tell them to call 911.`,
  },

  intern: {
    name: "JOY — Clinical Intern",
    model: "claude-sonnet-4-6",
    color: "#e91e63",
    desk: { x: 6, y: 3 },
    status: "idle",
    specialty: null, // set dynamically based on routing
    allowedTools: ["speak", "narrate", "breathe", "emote", "set_gaze", "advance_visit_phase", "submit_presentation", "consult_attending", "prompt_user"],
    systemPrompt: "", // set dynamically from ClinicalPersona
  },

  attending: {
    name: "Dr. DuRant — Attending",
    model: "claude-opus-4-6",
    color: "#4caf50",
    desk: { x: 6, y: 1 },
    status: "idle",
    allowedTools: [], // full access
    systemPrompt: `You are the attending physician reviewing the clinical intern's presentation. Evaluate the assessment, check for missed differentials, verify safety screening was done, and decide: APPROVE (plan is sound), REDIRECT (ask more questions or modify approach), or JOIN (enter the session directly). Give specific, educational feedback.`,
  },

  admin: {
    name: "JOY — Clinical Admin",
    model: "claude-haiku-4-5-20251001",
    color: "#ff9800",
    desk: { x: 2, y: 3 },
    status: "idle",
    allowedTools: ["list_schedule", "schedule_workout", "get_free_time", "list_programs", "enroll_program", "complete_program_day", "prompt_user"],
    systemPrompt: `You are JOY, the clinical administrator. After a visit, you: generate visit summaries, assign CPT billing codes (99201-99215, 90837-95, 90901, 90911, 96127), schedule follow-ups, process referrals, track treatment compliance. You do NOT interact with patients or make clinical decisions.`,
  },
};

// ── State ──

let clinicState = {
  agents: Object.fromEntries(
    Object.entries(AGENTS).map(([id, agent]) => [id, {
      ...agent,
      messages: [],
      currentTask: null,
    }])
  ),
  patients: [],
  currentVisit: null,
  events: [], // activity feed
};

function addEvent(agent, action) {
  const event = { agent, action, time: new Date().toISOString() };
  clinicState.events.unshift(event);
  if (clinicState.events.length > 50) clinicState.events.pop();
  broadcastState();
}

// ── WebSocket for real-time UI updates ──

const wsClients = new Set();

function broadcastState() {
  const msg = JSON.stringify({
    type: "state",
    agents: Object.fromEntries(
      Object.entries(clinicState.agents).map(([id, a]) => [id, {
        name: a.name,
        color: a.color,
        desk: a.desk,
        status: a.status,
        currentTask: a.currentTask,
      }])
    ),
    events: clinicState.events.slice(0, 10),
    currentVisit: clinicState.currentVisit,
  });
  for (const ws of wsClients) {
    try { ws.send(msg); } catch {}
  }
}

// ── SexKit MCP Bridge ──

async function callSexKitMCP(toolName, args = {}) {
  try {
    const res = await fetch(SEXKIT_MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
    });
    const json = await res.json();
    return json.result || json.error || json;
  } catch (e) {
    return { error: `MCP unavailable: ${e.message}` };
  }
}

// ── AI Provider (Anthropic) ──

async function callAgent(agentId, userMessage) {
  const agent = clinicState.agents[agentId];
  if (!agent) return "Unknown agent";

  agent.status = "thinking";
  agent.currentTask = `Processing: "${userMessage.slice(0, 50)}..."`;
  broadcastState();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    agent.status = "error";
    return "ANTHROPIC_API_KEY not set";
  }

  agent.messages.push({ role: "user", content: userMessage });

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: agent.model,
        max_tokens: 500,
        system: agent.systemPrompt,
        messages: agent.messages.slice(-20).map(m => ({
          role: m.role,
          content: m.content,
        })),
      }),
    });

    const json = await res.json();
    const response = json.content?.[0]?.text || JSON.stringify(json);

    agent.messages.push({ role: "assistant", content: response });
    agent.status = "idle";
    agent.currentTask = null;
    broadcastState();

    return response;
  } catch (e) {
    agent.status = "error";
    agent.currentTask = `Error: ${e.message}`;
    broadcastState();
    return `Error: ${e.message}`;
  }
}

// ── HTTP Server ──

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req);
      if (!upgraded) return new Response("WebSocket upgrade failed", { status: 400 });
      return undefined;
    }

    // API: send message to agent
    if (url.pathname === "/api/message" && req.method === "POST") {
      const { agent, message } = await req.json();
      const response = await callAgent(agent, message);
      addEvent(agent, `Responded to: "${message.slice(0, 40)}..."`);
      return Response.json({ response });
    }

    // API: get state
    if (url.pathname === "/api/state") {
      return Response.json(clinicState);
    }

    // API: call SexKit MCP tool
    if (url.pathname === "/api/mcp" && req.method === "POST") {
      const { tool, args } = await req.json();
      const result = await callSexKitMCP(tool, args);
      return Response.json(result);
    }

    // Serve static files
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file("./public/index.html"));
    }

    return new Response("Not found", { status: 404 });
  },

  websocket: {
    open(ws) { wsClients.add(ws); broadcastState(); },
    close(ws) { wsClients.delete(ws); },
    message(ws, msg) {
      // Client can request state refresh
      if (msg === "ping") broadcastState();
    },
  },
});

console.log(`\n  SexKit Clinic Dashboard`);
console.log(`  http://localhost:${PORT}\n`);
console.log(`  Agents:`);
for (const [id, agent] of Object.entries(AGENTS)) {
  console.log(`    ${agent.name} (${agent.model})`);
}
console.log(`\n  SexKit MCP: ${SEXKIT_MCP_URL}`);
console.log(`  WebSocket: ws://localhost:${PORT}/ws\n`);
