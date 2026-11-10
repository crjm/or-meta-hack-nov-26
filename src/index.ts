import { GameDO } from "./GameDO";

export { GameDO };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/") {
      return Response.json({ ok: true, endpoints: ["/ws", "/stats"] });
    }

    if (url.pathname === "/stats") {
      // Single global room: one DO instance for the whole game.
      const stub = env.GAME.get(env.GAME.idFromName("game"));
      return Response.json(await stub.getStats());
    }

    if (url.pathname === "/ws") {
      const stub = env.GAME.get(env.GAME.idFromName("game"));
      return stub.fetch(req);
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
