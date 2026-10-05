import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || resolve(here, "data/doorprize.db");
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);

/*
 * status:
 *   available -> masih bisa terundi
 *   won       -> sudah menang (prize_id + slot_no terisi)
 *   skipped   -> pemenang dibatalkan (respin), tidak masuk pool lagi sampai di-restore/reset
 */
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS participants (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    msisdn    TEXT NOT NULL UNIQUE,
    name      TEXT NOT NULL,
    region    TEXT NOT NULL DEFAULT '',
    status    TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','won','skipped')),
    prize_id  INTEGER,
    slot_no   INTEGER,
    won_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_participants_status ON participants(status);
  CREATE INDEX IF NOT EXISTS idx_participants_prize ON participants(prize_id);
`);

export function transaction(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
