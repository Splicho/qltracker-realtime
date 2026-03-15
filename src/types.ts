import { z } from "zod";

export const serverSnapshotSchema = z.object({
  addr: z.string().min(3),
  name: z.string().min(1),
  map: z.string().min(1),
  players: z.number().int().nonnegative(),
  maxPlayers: z.number().int().positive(),
  gameMode: z.string().nullable().optional(),
  requiresPassword: z.boolean().nullable().optional(),
  avgQelo: z.number().nullable().optional(),
  avgTrueskill: z.number().nullable().optional(),
  updatedAt: z.string().datetime().optional(),
  playersInfo: z
    .array(
      z.object({
        name: z.string(),
        score: z.number(),
        durationSeconds: z.number(),
        team: z.number().int().nullable().optional(),
      })
    )
    .default([]),
});

export type ServerSnapshot = z.infer<typeof serverSnapshotSchema>;
