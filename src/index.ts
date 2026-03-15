import cors from "cors";
import express from "express";
import http from "node:http";
import { Server } from "socket.io";
import { config } from "./config.js";
import { pool } from "./db.js";
import { enrichSnapshots } from "./enrichment.js";
import { fetchSteamSnapshots } from "./steam.js";
import {
  serverSnapshotSchema,
  type PlayerPresence,
  type ServerSnapshot,
} from "./types.js";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: config.corsOrigins,
  },
});

app.use(
  cors({
    origin: config.corsOrigins,
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));

let playerPresenceBySteamId = new Map<string, PlayerPresence>();
let snapshotsByAddr = new Map<string, ServerSnapshot>();

function getRoomName(addr: string) {
  return `server:${addr}`;
}

function getPresenceRoomName(steamId: string) {
  return `presence:${steamId}`;
}

async function upsertServerSnapshot(snapshot: ServerSnapshot) {
  const normalizedSnapshot = {
    ...snapshot,
    updatedAt: snapshot.updatedAt ?? new Date().toISOString(),
  };

  await pool.query(
    `
      insert into realtime.server_snapshots (addr, payload, updated_at)
      values ($1, $2::jsonb, now())
      on conflict (addr) do update
      set payload = excluded.payload,
          updated_at = excluded.updated_at
    `,
    [snapshot.addr, JSON.stringify(normalizedSnapshot)]
  );

  return normalizedSnapshot;
}

async function broadcastSnapshot(snapshot: ServerSnapshot) {
  io.to(getRoomName(snapshot.addr)).emit("server:snapshot", snapshot);
  io.emit("server:snapshot", snapshot);
}

function buildPlayerPresenceIndex(snapshots: ServerSnapshot[]) {
  const nextIndex = new Map<string, PlayerPresence>();

  for (const snapshot of snapshots) {
    for (const player of snapshot.playersInfo) {
      const steamId = player.steamId?.trim();
      if (!steamId) {
        continue;
      }

      nextIndex.set(steamId, {
        steamId,
        playerName: player.name,
        addr: snapshot.addr,
        serverName: snapshot.name,
        map: snapshot.map,
        gameMode: snapshot.gameMode ?? null,
        team: player.team ?? null,
        players: snapshot.players,
        maxPlayers: snapshot.maxPlayers,
        countryCode: snapshot.countryCode ?? null,
        countryName: snapshot.countryName ?? null,
        updatedAt: snapshot.updatedAt ?? new Date().toISOString(),
      });
    }
  }

  return nextIndex;
}

function replaceSnapshotsIndex(snapshots: ServerSnapshot[]) {
  snapshotsByAddr = new Map(
    snapshots.map((snapshot) => [snapshot.addr, snapshot] as const)
  );
}

function haveSamePresence(
  left: PlayerPresence | null | undefined,
  right: PlayerPresence | null | undefined
) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function broadcastPlayerPresenceChanges(nextIndex: Map<string, PlayerPresence>) {
  const steamIds = new Set([
    ...playerPresenceBySteamId.keys(),
    ...nextIndex.keys(),
  ]);

  for (const steamId of steamIds) {
    const currentPresence = playerPresenceBySteamId.get(steamId) ?? null;
    const nextPresence = nextIndex.get(steamId) ?? null;

    if (haveSamePresence(currentPresence, nextPresence)) {
      continue;
    }

    io.to(getPresenceRoomName(steamId)).emit("player:presence", {
      steamId,
      presence: nextPresence,
    });
  }

  playerPresenceBySteamId = nextIndex;
}

function rebuildAndBroadcastPlayerPresence() {
  broadcastPlayerPresenceChanges(
    buildPlayerPresenceIndex(Array.from(snapshotsByAddr.values()))
  );
}

async function runPollCycle() {
  if (!config.steamApiKey) {
    return;
  }

  const snapshots = await fetchSteamSnapshots();
  const enrichedSnapshots = await enrichSnapshots(snapshots);
  replaceSnapshotsIndex(enrichedSnapshots);

  for (const snapshot of enrichedSnapshots) {
    const storedSnapshot = await upsertServerSnapshot(snapshot);
    await broadcastSnapshot(storedSnapshot);
  }

  rebuildAndBroadcastPlayerPresence();

  console.log(`qltracker-realtime synced ${enrichedSnapshots.length} snapshots`);
}

function isAuthorizedIngestRequest(request: express.Request) {
  const headerToken =
    request.header("x-api-key") ??
    request.header("authorization")?.replace(/^Bearer\s+/i, "");

  return headerToken === config.ingestToken;
}

app.get("/health", async (_request, response) => {
  const result = await pool.query("select now() as now");

  response.json({
    ok: true,
    now: result.rows[0]?.now ?? null,
  });
});

app.get("/api/servers/:addr", async (request, response) => {
  const addr = decodeURIComponent(request.params.addr);
  const result = await pool.query(
    "select payload, updated_at from realtime.server_snapshots where addr = $1",
    [addr]
  );

  if (result.rowCount === 0) {
    response.status(404).json({ ok: false, error: "Server snapshot not found." });
    return;
  }

  response.json({
    ok: true,
    snapshot: result.rows[0]?.payload ?? null,
    updatedAt: result.rows[0]?.updated_at ?? null,
  });
});

app.post("/api/servers/lookup", async (request, response) => {
  const addrs = Array.isArray((request.body as { addrs?: unknown })?.addrs)
    ? ((request.body as { addrs: unknown[] }).addrs
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0))
    : [];

  if (addrs.length === 0) {
    response.json({ ok: true, snapshots: [] });
    return;
  }

  const result = await pool.query(
    "select payload from realtime.server_snapshots where addr = any($1::text[])",
    [addrs]
  );

  response.json({
    ok: true,
    snapshots: result.rows.map((row) => row.payload),
  });
});

app.get("/api/presence/:steamId", (request, response) => {
  const steamId = decodeURIComponent(request.params.steamId).trim();
  const presence = steamId ? (playerPresenceBySteamId.get(steamId) ?? null) : null;

  response.json({
    ok: true,
    presence,
  });
});

app.post("/api/ingest/server-snapshot", async (request, response) => {
  if (!isAuthorizedIngestRequest(request)) {
    response.status(401).json({ ok: false, error: "Unauthorized." });
    return;
  }

  const parsedSnapshot = serverSnapshotSchema.safeParse(request.body);
  if (!parsedSnapshot.success) {
    response.status(400).json({
      ok: false,
      error: "Invalid snapshot payload.",
      issues: parsedSnapshot.error.flatten(),
    });
    return;
  }

  const snapshot = await upsertServerSnapshot(parsedSnapshot.data);
  snapshotsByAddr.set(snapshot.addr, snapshot);
  rebuildAndBroadcastPlayerPresence();

  await broadcastSnapshot(snapshot);

  response.status(202).json({
    ok: true,
    snapshot,
  });
});

io.on("connection", (socket) => {
  socket.emit("realtime:ready", {
    connectedAt: new Date().toISOString(),
  });

  socket.on("servers:subscribe", async (payload: unknown) => {
    const parsed = Array.isArray((payload as { addrs?: unknown })?.addrs)
      ? ((payload as { addrs: unknown[] }).addrs
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter((value) => value.length > 0))
      : [];

    if (parsed.length === 0) {
      return;
    }

    for (const addr of parsed) {
      await socket.join(getRoomName(addr));
    }

    const result = await pool.query(
      "select payload from realtime.server_snapshots where addr = any($1::text[])",
      [parsed]
    );

    for (const row of result.rows) {
      socket.emit("server:snapshot", row.payload);
    }
  });

  socket.on("presence:subscribe", (payload: unknown) => {
    const steamId =
      typeof (payload as { steamId?: unknown })?.steamId === "string"
        ? (payload as { steamId: string }).steamId.trim()
        : "";

    if (!steamId) {
      return;
    }

    void socket.join(getPresenceRoomName(steamId));
    socket.emit("player:presence", {
      steamId,
      presence: playerPresenceBySteamId.get(steamId) ?? null,
    });
  });

  socket.on("presence:unsubscribe", (payload: unknown) => {
    const steamId =
      typeof (payload as { steamId?: unknown })?.steamId === "string"
        ? (payload as { steamId: string }).steamId.trim()
        : "";

    if (!steamId) {
      return;
    }

    void socket.leave(getPresenceRoomName(steamId));
  });
});

server.listen(config.port, () => {
  console.log(`qltracker-realtime listening on port ${config.port}`);

  if (!config.steamApiKey) {
    console.warn(
      "STEAM_API_KEY is not configured. Automatic Steam polling is disabled."
    );
    return;
  }

  void runPollCycle().catch((error: unknown) => {
    console.error("Initial Steam sync failed:", error);
  });

  setInterval(() => {
    void runPollCycle().catch((error: unknown) => {
      console.error("Steam sync failed:", error);
    });
  }, config.pollIntervalMs);
});
