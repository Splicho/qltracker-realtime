import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3011),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  CORS_ORIGIN: z.string().default("*"),
  REALTIME_INGEST_TOKEN: z.string().min(1, "REALTIME_INGEST_TOKEN is required"),
});

const parsedEnv = envSchema.parse(process.env);

export const config = {
  corsOrigins:
    parsedEnv.CORS_ORIGIN.trim() === "*"
      ? "*"
      : parsedEnv.CORS_ORIGIN.split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
  databaseUrl: parsedEnv.DATABASE_URL,
  ingestToken: parsedEnv.REALTIME_INGEST_TOKEN,
  port: parsedEnv.PORT,
};
