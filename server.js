import express from "express";
import cors from "cors";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { db, transaction } from "./db.js";

const PORT = Number(process.env.PORT) || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
if (!process.env.ADMIN_PASSWORD) {
  console.warn("[!] ADMIN_PASSWORD belum di-set, memakai default 'admin123'. Set di environment sebelum acara.");
}

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",") : true }));
app.use(express.json({ limit: "5mb" }));

/* ── Helpers ── */
const publicRow = (r) => ({ id: String(r.id), name: r.name, region: r.region });
const adminRow = (r) => ({
  id: r.id, msisdn: r.msisdn, name: r.name, region: r.region,
  status: r.status, prizeId: r.prize_id, slotNo: r.slot_no, wonAt: r.won_at,
});
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

/* ── Auth admin: login → token in-memory ── */
const tokens = new Set();
const safeEqual = (a, b) => {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};
const requireAdmin = (req, res, next) => {
  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  if (!tokens.has(token)) return bad(res, "Unauthorized", 401);
  next();
};

app.post("/api/admin/login", (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== "string" || !safeEqual(password, ADMIN_PASSWORD)) {
    return bad(res, "Password salah", 401);
  }
  const token = randomBytes(24).toString("hex");
  tokens.add(token);
  res.json({ token });
});

/* ── Publik (layar undian) ── */

// Semua peserta (untuk animasi acak di layar). Tanpa msisdn.
app.get("/api/pool", (_req, res) => {
  res.json(db.prepare("SELECT id, name, region FROM participants").all().map(publicRow));
});

// Pemenang aktif untuk satu hadiah, urut slot
app.get("/api/winners/:prizeId", (req, res) => {
  const rows = db
    .prepare("SELECT id, name, region, slot_no FROM participants WHERE status='won' AND prize_id=? ORDER BY slot_no")
    .all(Number(req.params.prizeId));
  res.json(rows.map((r) => ({ ...publicRow(r), slotNo: r.slot_no })));
});

// Undi `quantity` pemenang untuk hadiah. Ditolak bila hadiah itu sudah punya pemenang (reset dulu lewat admin).
app.post("/api/draw", (req, res) => {
  const prizeId = Number(req.body?.prizeId);
  const quantity = Number(req.body?.quantity);
  if (!Number.isInteger(prizeId) || !Number.isInteger(quantity) || quantity < 1) {
    return bad(res, "prizeId dan quantity tidak valid");
  }
  try {
    const winners = transaction(() => {
      const existing = db.prepare("SELECT COUNT(*) AS n FROM participants WHERE status='won' AND prize_id=?").get(prizeId).n;
      if (existing > 0) throw Object.assign(new Error("Hadiah ini sudah diundi"), { code: 409 });
      const pool = db.prepare("SELECT * FROM participants WHERE status='available'").all();
      if (pool.length < quantity) {
        throw Object.assign(new Error(`Peserta tersisa ${pool.length}, butuh ${quantity}`), { code: 409 });
      }
      const update = db.prepare("UPDATE participants SET status='won', prize_id=?, slot_no=?, won_at=datetime('now','localtime') WHERE id=?");
      const picked = [];
      for (let slot = 0; slot < quantity; slot++) {
        const p = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
        update.run(prizeId, slot, p.id);
        picked.push({ ...publicRow(p), slotNo: slot });
      }
      return picked;
    });
    res.json({ winners });
  } catch (e) {
    bad(res, e.message, e.code || 500);
  }
});

// Respin satu slot: pemenang lama jadi 'skipped', peserta baru menggantikan slot yang sama.
app.post("/api/redraw", (req, res) => {
  const prizeId = Number(req.body?.prizeId);
  const slotNo = Number(req.body?.slotNo);
  if (!Number.isInteger(prizeId) || !Number.isInteger(slotNo)) return bad(res, "prizeId dan slotNo tidak valid");
  try {
    const winner = transaction(() => {
      const old = db.prepare("SELECT id FROM participants WHERE status='won' AND prize_id=? AND slot_no=?").get(prizeId, slotNo);
      if (!old) throw Object.assign(new Error("Slot belum punya pemenang"), { code: 404 });
      const pool = db.prepare("SELECT * FROM participants WHERE status='available'").all();
      if (pool.length === 0) throw Object.assign(new Error("Tidak ada peserta tersisa"), { code: 409 });
      const p = pool[Math.floor(Math.random() * pool.length)];
      db.prepare("UPDATE participants SET status='skipped', prize_id=NULL, slot_no=NULL, won_at=NULL WHERE id=?").run(old.id);
      db.prepare("UPDATE participants SET status='won', prize_id=?, slot_no=?, won_at=datetime('now','localtime') WHERE id=?").run(prizeId, slotNo, p.id);
      return { ...publicRow(p), slotNo };
    });
    res.json({ winner });
  } catch (e) {
    bad(res, e.message, e.code || 500);
  }
});

/* ── Admin ── */
const admin = express.Router();
admin.use(requireAdmin);

admin.get("/participants", (_req, res) => {
  const rows = db.prepare("SELECT * FROM participants ORDER BY id").all().map(adminRow);
  const summary = db.prepare("SELECT status, COUNT(*) AS n FROM participants GROUP BY status").all();
  res.json({ participants: rows, summary: Object.fromEntries(summary.map((s) => [s.status, s.n])) });
});

// Ubah status satu peserta. 'available' = kembalikan ke pool (menghapus info kemenangan).
admin.patch("/participants/:id", (req, res) => {
  const id = Number(req.params.id);
  const { status, name, region } = req.body || {};
  const row = db.prepare("SELECT * FROM participants WHERE id=?").get(id);
  if (!row) return bad(res, "Peserta tidak ditemukan", 404);
  if (status !== undefined) {
    if (!["available", "skipped"].includes(status)) return bad(res, "Status hanya bisa 'available' atau 'skipped'");
    db.prepare("UPDATE participants SET status=?, prize_id=NULL, slot_no=NULL, won_at=NULL WHERE id=?").run(status, id);
  }
  if (typeof name === "string" && name.trim()) db.prepare("UPDATE participants SET name=? WHERE id=?").run(name.trim(), id);
  if (typeof region === "string") db.prepare("UPDATE participants SET region=? WHERE id=?").run(region.trim(), id);
  res.json(adminRow(db.prepare("SELECT * FROM participants WHERE id=?").get(id)));
});

admin.delete("/participants/:id", (req, res) => {
  const r = db.prepare("DELETE FROM participants WHERE id=?").run(Number(req.params.id));
  if (!r.changes) return bad(res, "Peserta tidak ditemukan", 404);
  res.json({ ok: true });
});

// Tambah/import peserta: body { participants: [{msisdn, name, region}] }. Duplikat msisdn dilewati.
admin.post("/participants", (req, res) => {
  const list = req.body?.participants;
  if (!Array.isArray(list) || list.length === 0) return bad(res, "participants harus array berisi data");
  const insert = db.prepare("INSERT OR IGNORE INTO participants (msisdn, name, region) VALUES (?, ?, ?)");
  let added = 0, skipped = 0;
  transaction(() => {
    for (const p of list) {
      const msisdn = String(p?.msisdn ?? "").trim();
      const name = String(p?.name ?? "").trim();
      if (!msisdn || !name) { skipped++; continue; }
      const changes = Number(insert.run(msisdn, name, String(p?.region ?? "").trim()).changes);
      if (changes) added++; else skipped++;
    }
  });
  res.json({ added, skipped });
});

// Reset: tanpa body = semua peserta jadi available; { prizeId } = hanya pemenang hadiah itu yang dikembalikan.
// { includeSkipped: true } (default true untuk reset semua) ikut mengembalikan peserta 'skipped'.
admin.post("/reset", (req, res) => {
  const prizeId = req.body?.prizeId;
  let changes;
  if (prizeId !== undefined && prizeId !== null) {
    changes = db.prepare("UPDATE participants SET status='available', prize_id=NULL, slot_no=NULL, won_at=NULL WHERE status='won' AND prize_id=?").run(Number(prizeId)).changes;
  } else {
    changes = db.prepare("UPDATE participants SET status='available', prize_id=NULL, slot_no=NULL, won_at=NULL WHERE status<>'available'").run().changes;
  }
  res.json({ reset: Number(changes) });
});

app.use("/api/admin", admin);

app.listen(PORT, () => console.log(`Doorprize backend jalan di http://localhost:${PORT}`));
