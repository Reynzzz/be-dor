import pg from "pg";

if (!process.env.DATABASE_URL) {
  console.error("[!] DATABASE_URL belum di-set. Contoh: postgres://user:password@localhost:5432/doorprize");
  process.exit(1);
}

// Tipe int8 (COUNT) dikembalikan sebagai number, bukan string
pg.types.setTypeParser(20, Number);

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
});

/*
 * status:
 *   available -> masih bisa terundi
 *   won       -> sudah menang (prize_id + slot_no terisi)
 *   skipped   -> pemenang dibatalkan (respin), tidak masuk pool lagi sampai di-restore/reset
 */
export async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS participants (
      id        SERIAL PRIMARY KEY,
      msisdn    TEXT NOT NULL UNIQUE,
      name      TEXT NOT NULL,
      region    TEXT NOT NULL DEFAULT '',
      status    TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','won','skipped')),
      prize_id  INTEGER,
      slot_no   INTEGER,
      won_at    TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_participants_status ON participants(status);
    CREATE INDEX IF NOT EXISTS idx_participants_prize ON participants(prize_id);
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value JSONB NOT NULL
    );
  `);
}

// Jalankan fn(client) dalam satu transaksi; COMMIT bila sukses, ROLLBACK bila throw.
export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
