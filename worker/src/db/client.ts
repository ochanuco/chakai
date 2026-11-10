import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.ts";

export const openDb = (d1: D1Database) => drizzle(d1, { schema });

export type Db = ReturnType<typeof openDb>;
