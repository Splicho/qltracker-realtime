import cors from "cors";
import express from "express";
import http from "node:http";
import { Server } from "socket.io";
import { config } from "./config.js";
import { pool } from "./db.js";
import { serverSnapshotSchema, type ServerSnapshot } from "./types.js";

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

function getRoomName(addr: string) {
  return `server:${addr}`;
}

async function upsertServerSnapshot(snapshot: ServerSnapshot) {
  const normalizedSnapshot = {
    ...snapshot,
    updatedAt: snapshot.updatedAt ?? new Date().toISOString(),
  };

  await pool.query(
    `
      insert into public.server_snapshots (addr, payload, updated_at)
      values ($1, $2::jsonb, now())
      on conflict (addr) do update
      set payload = excluded.payload,
          updated_at = excluded.updated_at
    `,
    [snapshot.addr, JSON.stringify(normalizedSnapshot)]
  );

  return normalizedSnapshot;
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
    "select payload, updated_at from public.server_snapshots where addr = $1",
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

  io.to(getRoomName(snapshot.addr)).emit("server:snapshot", snapshot);
  io.emit("server:snapshot", snapshot);

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
      "select payload from public.server_snapshots where addr = any($1::text[])",
      [parsed]
    );

    for (const row of result.rows) {
      socket.emit("server:snapshot", row.payload);
    }
  });
});

server.listen(config.port, () => {
  console.log(`qltracker-realtime listening on port ${config.port}`);
});
