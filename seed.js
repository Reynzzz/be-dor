// Import peserta awal dari frontend/src/data/NAMA_PESERTA.json (hanya jika tabel masih kosong, atau pakai --force)
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pool, initSchema, transaction } from "./db.js";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(here, "../frontend/src/data/NAMA_PESERTA.json");
const SHEET = "TOP 100 FLAIGHT KEBERANGKATAN 1";

try {
  await initSchema();
  const { rows: [{ n: count }] } = await pool.query("SELECT COUNT(*) AS n FROM participants");
  if (count > 0 && !process.argv.includes("--force")) {
    console.log(`Tabel sudah berisi ${count} peserta. Pakai --force untuk menambah yang belum ada.`);
  } else {
    const rows = JSON.parse(readFileSync(SOURCE, "utf8"))[SHEET];
    const added = await transaction(async (c) => {
      let n = 0;
      for (const r of rows) {
        const res = await c.query(
          "INSERT INTO participants (msisdn, name, region) VALUES ($1, $2, $3) ON CONFLICT (msisdn) DO NOTHING",
          [String(r.ro_msisdn), r.ro_name.trim(), r.ro_region.trim()],
        );
        n += res.rowCount;
      }
      return n;
    });
    console.log(`Selesai: ${added} peserta ditambahkan dari ${rows.length} baris.`);
  }
} finally {
  await pool.end();
}
