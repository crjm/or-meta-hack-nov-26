// Load test: N clients join the SAME room, verify they all see each other,
// stage ticks advance levels, and closing destroys the city.
// Usage: node test/load.mjs [N]   (default 10)
import WebSocket from "ws";

const N = parseInt(process.argv[2] || "10", 10);
const BASE = process.env.BASE || "http://127.0.0.1:8787";
const WS = BASE.replace(/^http/, "ws") + "/ws";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stats() {
  const r = await fetch(BASE + "/stats");
  return r.json();
}

function connect(i) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS);
    const client = { i, ws, welcome: null, lastState: null, stages: 0, pongs: 0 };
    ws.on("open", () => resolve(client));
    ws.on("error", reject);
    ws.on("message", (data) => {
      const m = JSON.parse(data.toString());
      if (m.type === "welcome") client.welcome = m;
      if (m.type === "state") client.lastState = m;
      if (m.type === "stage") client.stages++;
      if (m.type === "pong") client.pongs++;
    });
  });
}

console.log(`connecting ${N} clients to ${WS} ...`);
const clients = await Promise.all(Array.from({ length: N }, (_, i) => connect(i)));
console.log(`connected: ${clients.length}/${N}`);

await sleep(500);
let s = await stats();
console.log(`/stats -> count=${s.count} stage=${s.stage}`);
if (s.count !== N) throw new Error(`expected ${N} cities, got ${s.count}`);

// Everyone should see the full room (same map/room).
const seen = clients[0].lastState;
if (!seen || seen.count !== N) throw new Error(`client 0 sees count=${seen?.count}, expected ${N}`);
console.log(`client 0 sees all ${seen.count} cities in the room ✓`);

// Ping/pong sanity on one socket.
clients[0].ws.send(JSON.stringify({ type: "ping" }));
await sleep(300);
if (clients[0].pongs < 1) throw new Error("no pong received");
console.log("ping/pong ✓");

// Wait for at least one stage tick (STAGE_MS=3000 in wrangler.toml).
console.log("waiting for stage tick (mock LLM) ...");
await sleep(3600);
s = await stats();
console.log(`/stats -> count=${s.count} stage=${s.stage}`);
if (s.stage < 1) throw new Error("stage did not advance");
const maxLevel = Math.max(...s.cities.map((c) => c.level));
console.log(`stage advanced to ${s.stage}, max level=${maxLevel} ✓`);
if (clients.every((c) => c.stages === 0)) throw new Error("no client received stage event");

// Close half the clients — their cities must be destroyed.
const half = Math.ceil(N / 2);
for (const c of clients.slice(0, half)) c.ws.close();
await sleep(800);
s = await stats();
const expected = N - half;
console.log(`closed ${half}, /stats -> count=${s.count} (expected ${expected})`);
if (s.count !== expected) throw new Error(`expected ${expected} cities after close, got ${s.count}`);
console.log("city destroyed on leave ✓");

for (const c of clients.slice(half)) c.ws.close();
console.log(`\nPASS: ${N} concurrent in one room, ticks work, leave destroys city.`);
process.exit(0);
