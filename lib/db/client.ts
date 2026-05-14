import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env";
import * as schema from "./schema";

declare global {
  // eslint-disable-next-line no-var
  var __magenta_pg: ReturnType<typeof postgres> | undefined;
}

const client =
  global.__magenta_pg ??
  postgres(env.DATABASE_URL, {
    max: 10,
    prepare: false,
  });

if (env.NODE_ENV !== "production") {
  global.__magenta_pg = client;
}

export const db = drizzle(client, { schema });
export type DB = typeof db;
