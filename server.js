import express from "express";
import cors from "cors";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { pool, initSchema, transaction } from "./db.js";

const PORT = Number(process.env.PORT) || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
if (!process.env.ADMIN_PASSWORD) {
  console.warn("[!] ADMIN_PASSWORD belum di-set, memakai default 'admin123'. Set di environment sebelum acara.");
}

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean) : true }));
app.use(express.json({ limit: "5mb" }));

/* ── Helpers ── */
const publicRow = (r) => ({ id: String(r.id), name: r.name, region: r.region });
const WON_AT = "to_char(won_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI:SS')";
const ADMIN_COLS = `id, msisdn, name, region, status, prize_id, slot_no, ${WON_AT} AS won_at`;
const adminRow = (r) => ({
  id: r.id, msisdn: r.msisdn, name: r.name, region: r.region,
  status: r.status, prizeId: r.prize_id, slotNo: r.slot_no, wonAt: r.won_at,
});
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
// Error yang sengaja dilempar (punya status HTTP numerik) vs error tak terduga (mis. koneksi DB)
const fail = (msg, status) => Object.assign(new Error(msg), { status });
// Bungkus handler async agar error masuk ke respons JSON (Express 4 tidak menangkap rejection)
const h = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    if (e.status) return bad(res, e.message, e.status);
    console.error(e);
    bad(res, "Terjadi kesalahan server", 500);
  });

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

/* ── Pengaturan tampilan (logo kiri/kanan atas) ── */
const DEFAULT_SETTINGS = {
  logoLeft: { visible: true, height: 130 },
  logoRight: { visible: true, height: 110 },
};
const readSettings = async () => {
  const { rows } = await pool.query("SELECT value FROM settings WHERE key='display'");
  const saved = rows[0]?.value || {};
  return {
    logoLeft: { ...DEFAULT_SETTINGS.logoLeft, ...saved.logoLeft },
    logoRight: { ...DEFAULT_SETTINGS.logoRight, ...saved.logoRight },
  };
};
const cleanLogo = (v, def) => ({
  visible: typeof v?.visible === "boolean" ? v.visible : def.visible,
  height: Number.isFinite(Number(v?.height)) ? Math.min(400, Math.max(20, Math.round(Number(v.height)))) : def.height,
});

/* ── Publik (layar undian) ── */

app.get("/api/settings", h(async (_req, res) => res.json(await readSettings())));

// Semua peserta (untuk animasi acak di layar). Tanpa msisdn.
app.get("/api/pool", h(async (_req, res) => {
  const { rows } = await pool.query("SELECT id, name, region FROM participants ORDER BY id");
  res.json(rows.map(publicRow));
}));

// Pemenang aktif untuk satu hadiah, urut slot
app.get("/api/winners/:prizeId", h(async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, name, region, slot_no FROM participants WHERE status='won' AND prize_id=$1 ORDER BY slot_no",
    [Number(req.params.prizeId)],
  );
  res.json(rows.map((r) => ({ ...publicRow(r), slotNo: r.slot_no })));
}));

// Undi `quantity` pemenang untuk hadiah. Ditolak bila hadiah itu sudah punya pemenang (reset dulu lewat admin).
app.post("/api/draw", h(async (req, res) => {
  const prizeId = Number(req.body?.prizeId);
  const quantity = Number(req.body?.quantity);
  if (!Number.isInteger(prizeId) || !Number.isInteger(quantity) || quantity < 1) {
    return bad(res, "prizeId dan quantity tidak valid");
  }
  const winners = await transaction(async (c) => {
    // Serialkan semua undian/respin: hanya satu transaksi undian berjalan sekaligus
    await c.query("SELECT pg_advisory_xact_lock(1)");
    const { rows: [{ n: existing }] } = await c.query(
      "SELECT COUNT(*) AS n FROM participants WHERE status='won' AND prize_id=$1", [prizeId]);
    if (existing > 0) throw fail("Hadiah ini sudah diundi", 409);
    const { rows: picked } = await c.query(
      "SELECT id, name, region FROM participants WHERE status='available' ORDER BY random() LIMIT $1", [quantity]);
    if (picked.length < quantity) throw fail(`Peserta tersisa ${picked.length}, butuh ${quantity}`, 409);
    const out = [];
    for (let slot = 0; slot < picked.length; slot++) {
      await c.query("UPDATE participants SET status='won', prize_id=$1, slot_no=$2, won_at=now() WHERE id=$3",
        [prizeId, slot, picked[slot].id]);
      out.push({ ...publicRow(picked[slot]), slotNo: slot });
    }
    return out;
  });
  res.json({ winners });
}));

// Respin satu slot: pemenang lama jadi 'skipped', peserta baru menggantikan slot yang sama.
app.post("/api/redraw", h(async (req, res) => {
  const prizeId = Number(req.body?.prizeId);
  const slotNo = Number(req.body?.slotNo);
  if (!Number.isInteger(prizeId) || !Number.isInteger(slotNo)) return bad(res, "prizeId dan slotNo tidak valid");
  const winner = await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(1)");
    const { rows: [old] } = await c.query(
      "SELECT id FROM participants WHERE status='won' AND prize_id=$1 AND slot_no=$2", [prizeId, slotNo]);
    if (!old) throw fail("Slot belum punya pemenang", 404);
    const { rows: [p] } = await c.query(
      "SELECT id, name, region FROM participants WHERE status='available' ORDER BY random() LIMIT 1");
    if (!p) throw fail("Tidak ada peserta tersisa", 409);
    await c.query("UPDATE participants SET status='skipped', prize_id=NULL, slot_no=NULL, won_at=NULL WHERE id=$1", [old.id]);
    await c.query("UPDATE participants SET status='won', prize_id=$1, slot_no=$2, won_at=now() WHERE id=$3", [prizeId, slotNo, p.id]);
    return { ...publicRow(p), slotNo };
  });
  res.json({ winner });
}));

/* ── Admin ── */
const admin = express.Router();
admin.use(requireAdmin);

admin.get("/participants", h(async (_req, res) => {
  const { rows } = await pool.query(`SELECT ${ADMIN_COLS} FROM participants ORDER BY id`);
  const { rows: summary } = await pool.query("SELECT status, COUNT(*) AS n FROM participants GROUP BY status");
  res.json({ participants: rows.map(adminRow), summary: Object.fromEntries(summary.map((s) => [s.status, s.n])) });
}));

// Ubah status satu peserta. 'available' = kembalikan ke pool (menghapus info kemenangan).
admin.patch("/participants/:id", h(async (req, res) => {
  const id = Number(req.params.id);
  const { status, name, region } = req.body || {};
  if (!Number.isInteger(id)) return bad(res, "ID tidak valid");
  if (status !== undefined && !["available", "skipped"].includes(status)) {
    return bad(res, "Status hanya bisa 'available' atau 'skipped'");
  }
  const row = await transaction(async (c) => {
    const found = await c.query("SELECT 1 FROM participants WHERE id=$1 FOR UPDATE", [id]);
    if (!found.rowCount) throw fail("Peserta tidak ditemukan", 404);
    if (status !== undefined) {
      await c.query("UPDATE participants SET status=$1, prize_id=NULL, slot_no=NULL, won_at=NULL WHERE id=$2", [status, id]);
    }
    if (typeof name === "string" && name.trim()) await c.query("UPDATE participants SET name=$1 WHERE id=$2", [name.trim(), id]);
    if (typeof region === "string") await c.query("UPDATE participants SET region=$1 WHERE id=$2", [region.trim(), id]);
    return (await c.query(`SELECT ${ADMIN_COLS} FROM participants WHERE id=$1`, [id])).rows[0];
  });
  res.json(adminRow(row));
}));

admin.delete("/participants/:id", h(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return bad(res, "ID tidak valid");
  const r = await pool.query("DELETE FROM participants WHERE id=$1", [id]);
  if (!r.rowCount) return bad(res, "Peserta tidak ditemukan", 404);
  res.json({ ok: true });
}));

// Tambah/import peserta: body { participants: [{msisdn, name, region}] }. Duplikat msisdn dilewati.
admin.post("/participants", h(async (req, res) => {
  const list = req.body?.participants;
  if (!Array.isArray(list) || list.length === 0) return bad(res, "participants harus array berisi data");
  const result = await transaction(async (c) => {
    let added = 0, skipped = 0;
    for (const p of list) {
      const msisdn = String(p?.msisdn ?? "").trim();
      const name = String(p?.name ?? "").trim();
      if (!msisdn || !name) { skipped++; continue; }
      const r = await c.query(
        "INSERT INTO participants (msisdn, name, region) VALUES ($1, $2, $3) ON CONFLICT (msisdn) DO NOTHING",
        [msisdn, name, String(p?.region ?? "").trim()]);
      if (r.rowCount) added++; else skipped++;
    }
    return { added, skipped };
  });
  res.json(result);
}));

// Reset: tanpa body = semua peserta jadi available; { prizeId } = hanya pemenang hadiah itu yang dikembalikan.
admin.post("/reset", h(async (req, res) => {
  const prizeId = req.body?.prizeId;
  const clear = "UPDATE participants SET status='available', prize_id=NULL, slot_no=NULL, won_at=NULL";
  const r = prizeId !== undefined && prizeId !== null
    ? await pool.query(`${clear} WHERE status='won' AND prize_id=$1`, [Number(prizeId)])
    : await pool.query(`${clear} WHERE status<>'available'`);
  res.json({ reset: r.rowCount });
}));

admin.put("/settings", h(async (req, res) => {
  const cur = await readSettings();
  const next = {
    logoLeft: cleanLogo(req.body?.logoLeft, cur.logoLeft),
    logoRight: cleanLogo(req.body?.logoRight, cur.logoRight),
  };
  await pool.query(
    "INSERT INTO settings (key, value) VALUES ('display', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [JSON.stringify(next)]);
  res.json(next);
}));

app.use("/api/admin", admin);

await initSchema();
app.listen(PORT, () => console.log(`Doorprize backend jalan di http://localhost:${PORT}`));
