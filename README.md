# Empire Builder — Tiny City Tycoon

Real-time multiplayer city game: humans join by scanning a QR code (or opening
the URL). Each connection is a city owned by one human. The city **grows randomly
each turn** — the human only watches, and chooses when to quit (close the page or
Abandon → city destroyed). A human can **only see their own city**; the server
still tracks everyone for rank/count. No sign-in.

**Live:** https://or-meta-game.julian-479.workers.dev

## Architecture (all Cloudflare)

```
Worker (src/index.ts) + Static Assets (public/)
  ├─ GET /            → Three.js frontend (public/index.html, app.js, style.css)
  ├─ GET /stats       → RPC to DO: live cities + stage
  └─ GET /ws (upgrade)→ one Durable Object instance "game" = the whole room
        src/GameDO.ts — cities in DO SQLite, stage tick via ctx.storage.setAlarm()
        · join → create city (manor) · leave → delete city
        · alarm tick → randomGrowth() per city, level/score evolve,
          broadcast {stage, decisions} + {state} to all sockets (hibernation-aware)
        · pruneOrphans() each tick; empty room → stage resets to 0, alarm stops
```

Frontend: Three.js low-poly — manor + per-level halls/towers on a shared grid map,
center plaza, trees, flags, name labels, orbit camera, my-city HUD + rank,
QR invite panel, Abandon-city button. WS auto-reconnects (a reconnect = a
brand-new city, per spec; Abandon does not reconnect).

## Run / test / deploy

```bash
bun install
bunx wrangler dev            # http://localhost:8787 (frontend + backend together)
node test/load.mjs 10        # N concurrent clients in the same room (10/50/100 all pass)
BASE=https://or-meta-game.julian-479.workers.dev node test/load.mjs 50   # against prod
bunx wrangler deploy
```

Stage pace: `STAGE_MS` in wrangler.toml (3000 for testing; raise to 20000–30000 for real play).

## Gotchas learned (Cloudflare DO)

1. **Existing DO instances stay pinned to the code they were created with.**
   After `wrangler deploy`, the live instance kept running old code (alarm never
   stopped) until we `wrangler delete` + redeploy. For DO code changes in dev,
   delete+redeploy, or bump the instance name in `src/index.ts`.
2. **`storage.sql.exec(...).one()` throws on zero rows** — it does NOT return null.
   Iterate (`[...exec(...)]`) and check length. Caused a prod 1101, caught by tail.
3. **In-memory state dies on hibernation/eviction.** Cities + stage live in SQLite;
   per-socket data in `serializeAttachment()`; timers via `setAlarm()`, never `setTimeout`.
4. **`wrangler durable-objects list` doesn't exist** in current wrangler — use tail/stats.

## Next steps

- [ ] Stage cadence + win condition (who "wins" — highest level/score at quit?)
- [ ] Raise `STAGE_MS` for real play (currently 3s test pace)
- [ ] Print/display the QR code at the venue (📱 Invite button in the HUD)
