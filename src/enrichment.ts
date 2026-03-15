import { config } from "./config.js";
import type { ServerSnapshot } from "./types.js";

type QlStatsServerResponse = {
  players?: Array<Record<string, unknown>>;
  serverinfo?: {
    gt?: string | null;
  } | null;
};

type CachedTrueskill = {
  cachedAt: number;
  value: number | null;
};

const trueskillCache = new Map<string, CachedTrueskill>();
const trueskillTtlMs = 1000 * 60 * 5;

function qlstatsValueAsString(
  value: Record<string, unknown>,
  key: string
): string | null {
  const field = value[key];

  return typeof field === "string" && field.trim().length > 0
    ? field.trim()
    : null;
}

function qlstatsValueAsNumber(
  value: Record<string, unknown>,
  key: string
): number | null {
  const field = value[key];

  if (typeof field === "number" && Number.isFinite(field)) {
    return field;
  }

  if (typeof field === "string") {
    const parsed = Number(field.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function extractFirstPlausibleNumber(input: string) {
  const matches = input.match(/-?\d+(?:\.\d+)?/g) ?? [];

  for (const match of matches) {
    const value = Number(match);
    if (
      Number.isFinite(value) &&
      value > 0 &&
      value < 10000 &&
      value !== 1500
    ) {
      return value;
    }
  }

  return null;
}

function extractRatingNumber(input: string) {
  const lowered = input.toLowerCase();
  const keywords = ["trueskill", "rating", "elo", "mu"];

  for (const keyword of keywords) {
    const index = lowered.indexOf(keyword);
    if (index !== -1) {
      const value = extractFirstPlausibleNumber(
        lowered.slice(index + keyword.length)
      );
      if (value != null) {
        return value;
      }
    }
  }

  return extractFirstPlausibleNumber(lowered);
}

async function fetchTrueskill(steamId: string) {
  const cached = trueskillCache.get(steamId);
  if (cached && Date.now() - cached.cachedAt <= trueskillTtlMs) {
    return cached.value;
  }

  const template = config.trueskillUrlTemplate;
  if (!template) {
    return null;
  }

  const url = template.includes("%s")
    ? template.replace("%s", steamId)
    : `${template.replace(/\/+$/, "")}/${steamId}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      trueskillCache.set(steamId, { cachedAt: Date.now(), value: null });
      return null;
    }

    const body = await response.text();
    let value: number | null = null;

    try {
      const json = JSON.parse(body) as unknown;
      if (typeof json === "number" && Number.isFinite(json)) {
        value = json;
      } else if (json && typeof json === "object") {
        for (const key of ["elo", "trueskill", "rating", "mu"]) {
          const field = (json as Record<string, unknown>)[key];
          if (typeof field === "number" && Number.isFinite(field)) {
            value = field;
            break;
          }
          if (typeof field === "string") {
            const parsed = Number(field.trim());
            if (Number.isFinite(parsed)) {
              value = parsed;
              break;
            }
          }
        }
      }
    } catch {
      value = extractRatingNumber(body);
    }

    trueskillCache.set(steamId, { cachedAt: Date.now(), value });
    return value;
  } catch {
    return null;
  }
}

function calculateAverage(values: Array<number | null | undefined>) {
  const numbers = values.filter((value): value is number => value != null);
  if (numbers.length === 0) {
    return null;
  }

  return Math.round(
    numbers.reduce((total, value) => total + value, 0) / numbers.length
  );
}

async function enrichSnapshot(snapshot: ServerSnapshot) {
  if (snapshot.players <= 0) {
    return snapshot;
  }

  const response = await fetch(
    `${config.qlstatsApiUrl}/server/${encodeURIComponent(snapshot.addr)}/players`
  );

  if (!response.ok) {
    return snapshot;
  }

  const payload = (await response.json()) as QlStatsServerResponse;
  const qlstatsPlayers = payload.players ?? [];

  const playersInfo = await Promise.all(
    qlstatsPlayers.map(async (player) => {
      const steamId =
        qlstatsValueAsString(player, "steamid") ??
        qlstatsValueAsString(player, "steam_id");
      const qelo =
        qlstatsValueAsNumber(player, "rating") ??
        qlstatsValueAsNumber(player, "elo");

      return {
        durationSeconds: 0,
        name:
          qlstatsValueAsString(player, "name") ??
          qlstatsValueAsString(player, "nick") ??
          qlstatsValueAsString(player, "client_name") ??
          "Unknown player",
        qelo,
        score: qlstatsValueAsNumber(player, "score") ?? 0,
        steamId,
        team: qlstatsValueAsNumber(player, "team"),
        trueskill: steamId ? await fetchTrueskill(steamId) : null,
      };
    })
  );

  return {
    ...snapshot,
    avgQelo: calculateAverage(playersInfo.map((player) => player.qelo)),
    avgTrueskill: calculateAverage(playersInfo.map((player) => player.trueskill)),
    gameMode: payload.serverinfo?.gt ?? snapshot.gameMode ?? null,
    playersInfo,
  };
}

export async function enrichSnapshots(snapshots: ServerSnapshot[]) {
  const results: ServerSnapshot[] = [];
  const chunkSize = 8;

  for (let index = 0; index < snapshots.length; index += chunkSize) {
    const chunk = snapshots.slice(index, index + chunkSize);
    const enrichedChunk = await Promise.all(
      chunk.map(async (snapshot) => {
        try {
          return await enrichSnapshot(snapshot);
        } catch {
          return snapshot;
        }
      })
    );

    results.push(...enrichedChunk);
  }

  return results;
}
