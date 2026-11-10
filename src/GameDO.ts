import { DurableObject } from "cloudflare:workers";

export interface City {
  id: string;
  name: string;
  level: number;
  score: number;
  buildings: string[];
}

interface Attachment {
  playerId: string;
}

const NAMES = [
  "Ashford", "Briarhelm", "Coldmere", "Dunwatch", "Eldermere", "Frostford",
  "Grimhold", "Hallowmere", "Ironwatch", "Kingsford", "Lowmere", "Mistral",
  "Northford", "Oakenshield", "Ravenhold", "Stonebridge", "Thornwick", "Wexford",
];

// Growth is RANDOM each turn — the human owner only watches and chooses when to quit.
function randomGrowth(): { choice: string; gained: number } {
  const choices = ["expand", "fortify", "trade", "research"];
  const choice = choices[Math.floor(Math.random() * choices.length)];
  const gained = 25 + Math.floor(Math.random() * 40); // ~level-up every 2 stages
  return { choice, gained };
}

export class GameDO extends DurableObject<Env> {
  private stage: number | null = null; // lazy-loaded from storage (survives hibernation)

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Survives hibernation/eviction (in-memory only state would be lost).
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS cities (id TEXT PRIMARY KEY, data TEXT NOT NULL)"
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    );
  }

  private getStage(): number {
    if (this.stage === null) {
      // NOTE: sql.exec(...).one() THROWS on zero rows — iterate instead.
      const rows = [...this.ctx.storage.sql.exec("SELECT value FROM meta WHERE key = 'stage'")];
      this.stage = rows.length ? Number(rows[0].value) : 0;
    }
    return this.stage;
  }

  private setStage(n: number) {
    this.stage = n;
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('stage', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      String(n)
    );
  }

  private stageMs(): number {
    return Number(this.env.STAGE_MS ?? 3000) || 3000;
  }

  private allCities(): City[] {
    const rows = this.ctx.storage.sql.exec("SELECT data FROM cities");
    return [...rows].map((r) => JSON.parse(r.data as string) as City);
  }

  private saveCity(city: City) {
    this.ctx.storage.sql.exec(
      "INSERT INTO cities (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
      city.id,
      JSON.stringify(city)
    );
  }

  private broadcast(msg: unknown) {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        /* dead socket will be cleaned up in webSocketClose */
      }
    }
  }

  // If the DO restarted / sockets died without webSocketClose, cities would
  // orphan forever. Reconcile the table against live sockets on each tick.
  private pruneOrphans() {
    const live = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.playerId) live.add(att.playerId);
    }
    for (const city of this.allCities()) {
      if (!live.has(city.id)) {
        this.ctx.storage.sql.exec("DELETE FROM cities WHERE id = ?", city.id);
      }
    }
  }

  private broadcastState() {
    const cities = this.allCities().sort((a, b) => b.score - a.score);
    this.broadcast({ type: "state", stage: this.getStage(), count: cities.length, cities });
  }

  // RPC — used by Worker for GET /stats (avoids a fetch round-trip).
  async getStats() {
    const cities = this.allCities();
    return { count: cities.length, stage: this.getStage(), cities };
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 400 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    const playerId = crypto.randomUUID();

    // Attachment survives hibernation — this is how we know whose city
    // to destroy when the socket closes, even after the DO wakes up fresh.
    server.serializeAttachment({ playerId } satisfies Attachment);
    this.ctx.acceptWebSocket(server, ["game"]);

    const name = NAMES[this.allCities().length % NAMES.length] + "-" + playerId.slice(0, 4);
    const city: City = { id: playerId, name, level: 1, score: 0, buildings: ["manor"] };
    this.saveCity(city);

    server.send(JSON.stringify({ type: "welcome", playerId, city }));

    // Make sure the stage tick loop is running.
    const alarm = await this.ctx.storage.getAlarm();
    if (!alarm) await this.ctx.storage.setAlarm(Date.now() + this.stageMs());

    this.broadcastState();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const { playerId } = ws.deserializeAttachment() as Attachment;
    let msg: { type?: string; choice?: string };
    try {
      msg = JSON.parse(raw as string);
    } catch {
      return;
    }

    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }

    if (msg.type === "decide") {
      // Player-triggered growth (same random growth as the stage tick).
      const rows = [...this.ctx.storage.sql.exec("SELECT data FROM cities WHERE id = ?", playerId)];
      if (!rows.length) return;
      const city = JSON.parse(rows[0].data as string) as City;
      const d = randomGrowth();
      city.score += d.gained;
      if (city.score >= city.level * 100) {
        city.level++;
        city.buildings.push(`hall-${city.level}`);
      }
      this.saveCity(city);
      ws.send(JSON.stringify({ type: "decided", choice: d.choice, gained: d.gained, city }));
      this.broadcastState();
    }
  }

  async webSocketClose(ws: WebSocket) {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.playerId) {
      // Leave = city destroyed. No persistence, no grace period (for now).
      this.ctx.storage.sql.exec("DELETE FROM cities WHERE id = ?", att.playerId);
    }
    this.broadcastState();
  }

  async webSocketError(_ws: WebSocket, err: unknown) {
    console.error("ws error", err);
  }

  // Stage tick: every owned city grows randomly, empire evolves,
  // rank/count update server-side. Reschedules itself — this is the game loop.
  async alarm() {
    this.pruneOrphans();
    const cities = this.allCities();
    if (cities.length === 0) {
      // Room empty: stop the loop and reset for the next game.
      // (First join re-arms the alarm in fetch().)
      this.setStage(0);
      return;
    }
    this.setStage(this.getStage() + 1);
    const decisions: Record<string, string> = {};

    for (const city of cities) {
      const d = randomGrowth();
      decisions[city.id] = d.choice;
      city.score += d.gained;
      if (city.score >= city.level * 100) {
        city.level++;
        city.buildings.push(`hall-${city.level}`);
      }
      this.saveCity(city);
    }

    this.broadcast({ type: "stage", stage: this.getStage(), decisions });
    this.broadcastState();
    await this.ctx.storage.setAlarm(Date.now() + this.stageMs());
  }
}
