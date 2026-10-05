// Import peserta awal dari frontend/src/data/NAMA_PESERTA.json (hanya jika tabel masih kosong, atau pakai --force)
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./db.js";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(here, "../frontend/src/data/NAMA_PESERTA.json");
const SHEET = "TOP 100 FLAIGHT KEBERANGKATAN 1";

const count = db.prepare("SELECT COUNT(*) AS n FROM participants").get().n;
if (count > 0 && !process.argv.includes("--force")) {
  console.log(`Tabel sudah berisi ${count} peserta. Pakai --force untuk menambah yang belum ada.`);
  process.exit(0);
}

const rows = JSON.parse(readFileSync(SOURCE, "utf8"))[SHEET];
const insert = db.prepare(
  "INSERT OR IGNORE INTO participants (msisdn, name, region) VALUES (?, ?, ?)"
);
let added = 0;
db.exec("BEGIN");
for (const r of rows) {
  added += Number(insert.run(String(r.ro_msisdn), r.ro_name.trim(), r.ro_region.trim()).changes);
}
db.exec("COMMIT");
console.log(`Selesai: ${added} peserta ditambahkan dari ${rows.length} baris.`);
