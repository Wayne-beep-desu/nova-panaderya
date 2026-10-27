try { process.loadEnvFile(); } catch {}
const express = require("express"), session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const bcrypt = require("bcryptjs"), Database = require("better-sqlite3");
const helmet = require("helmet"), rateLimit = require("express-rate-limit");
const path = require("path"), fs = require("fs"), crypto = require("crypto");

const PROD = process.env.NODE_ENV === "production";
if (PROD && (process.env.SESSION_SECRET || "").length < 24) {
  console.error("SESSION_SECRET (hindi bababa sa 24 characters) ang kailangan sa production."); process.exit(1);
}
const app = express(), PORT = process.env.PORT || 3000;
if (PROD) app.set("trust proxy", 1);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "data", "nova.sqlite");
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL"); db.pragma("foreign_keys = ON");

/* ---------- schema (v2) ---------- */
if (db.pragma("user_version", { simple: true }) < 2) {
  for (const t of ["orders", "menu"])
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)) db.exec(`ALTER TABLE ${t} RENAME TO ${t}_v1`);
  db.pragma("user_version = 2");
}
db.exec(`
 CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'customer',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE IF NOT EXISTS menu(k TEXT PRIMARY KEY,name TEXT NOT NULL,price REAL NOT NULL CHECK(price>=0),stock INTEGER CHECK(stock IS NULL OR stock>=0),hot INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,user_id INTEGER,phone TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'Bago',dkey TEXT NOT NULL,slot TEXT NOT NULL,total REAL NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS orders_phone ON orders(phone);
 CREATE TABLE IF NOT EXISTS slots(id TEXT PRIMARY KEY,c INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS loyalty(phone TEXT PRIMARY KEY,c INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS notify(id INTEGER PRIMARY KEY AUTOINCREMENT,k TEXT NOT NULL,item TEXT NOT NULL,name TEXT NOT NULL,phone TEXT NOT NULL,at INTEGER NOT NULL,done INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY AUTOINCREMENT,n TEXT NOT NULL,s TEXT NOT NULL,t TEXT NOT NULL,at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY,value TEXT NOT NULL);
`);
const seed = db.prepare("INSERT OR IGNORE INTO menu(k,name,price,stock) VALUES(?,?,?,?)");
[["pandesal","Pandesal",60],["spanish","Spanish Bread",30],["cheese","Keso Bread",45],["bun","Pan de Leche",25],["monay","Monay",12],
 ["ensaymada","Ensaymada",35],["pandecoco","Pan de Coco",15],["hopia","Hopia Ube",15],["empanada","Empanada",35],["mamon","Mamon",20],
 ["brownies","Brownies",35],["eggpie","Egg Pie (hiwa)",40],["kape","Kape",25],["tsokolate","Mainit na Tsokolate",30]].forEach(x => seed.run(...x, 99));
[["box6","Pang-almusal Box",180],["box12","Pamilya Box",340],["box24","Handaan Box",640],["combo1","Pandesal + Kape",75],["combo2","Meryenda Combo",99]]
  .forEach(x => seed.run(...x, null)); // packages: walang stock limit
if (process.env.ADMIN_EMAIL) db.prepare("UPDATE users SET role='admin' WHERE email=?").run(process.env.ADMIN_EMAIL.trim().toLowerCase());

const CFG_DEF = { shop: { cap: 10, sp: "", fb: "", ig: "", tt: "" }, pay: { num: "09054469429", name: "Nova Panaderya", qr: "" } };
const getCfg = k => { const r = db.prepare("SELECT value FROM config WHERE key=?").get(k); let v = {}; try { v = r ? JSON.parse(r.value) : {}; } catch {} return { ...CFG_DEF[k], ...v }; };
const setCfg = (k, v) => db.prepare("INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, JSON.stringify(v));

/* ---------- helpers ---------- */
class HttpErr extends Error { constructor(s, m) { super(m); this.s = s; } }
const clean = s => String(s ?? "").trim();
const manila = () => new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Manila" }));
const dkey = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
const nextDays = () => Array.from({ length: 7 }, (_, i) => { const d = manila(); d.setDate(d.getDate() + i); return d; });
const SLOTS = []; for (let h = 6; h <= 20; h++) [0, 30].forEach(m => SLOTS.push({ m: h * 60 + m, t: (h > 12 ? h - 12 : h) + ":" + (m ? "30" : "00") + (h >= 12 ? " PM" : " AM") }));
const sid = (k, t) => k + "_" + t.replace(/[^0-9APM]/g, "");
function phone10(p) { const m = String(p || "").replace(/[\s\-().]/g, "").match(/^(?:\+?63|0)(9\d{9})$/); return m ? m[1] : null; }
const STATUSES = ["Bago", "Niluluto", "Handa na", "Tapos", "Kanselado"];
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, role: u.role });
function currentUser(req) { const id = req.session.user && req.session.user.id; return id ? db.prepare("SELECT id,name,email,role FROM users WHERE id=?").get(id) || null : null; }
const requireAdmin = (req, res, next) => { const u = currentUser(req); if (!u || u.role !== "admin") return res.status(403).json({ message: "Admin access lang ang puwede rito." }); req.user = u; next(); };
async function sendSms(to, message) {
  if (!process.env.SEMAPHORE_API_KEY) return;
  try { await fetch("https://api.semaphore.co/api/v4/messages", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ apikey: process.env.SEMAPHORE_API_KEY, number: to, message, sendername: process.env.SEMAPHORE_SENDER || "SEMAPHORE" }) }); }
  catch { console.error("Hindi naipadala ang SMS."); }
}

/* ---------- middleware ---------- */
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false })); // may inline scripts pa ang page; i-enable ang CSP kapag nailipat na ang mga ito
app.use(express.json({ limit: "100kb" }));
app.use(session({
  name: "nova.sid", store: new SQLiteStore({ db: "sessions.sqlite", dir: path.dirname(DB_FILE) }),
  secret: process.env.SESSION_SECRET || "dev-only-secret-change-me", resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: PROD, maxAge: 864e5 }
}));
app.use("/api", (req, res, next) => { // proteksyon laban sa CSRF: same-origin + JSON lang ang mutating requests
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const o = req.get("origin");
  try { if (o && new URL(o).host !== req.get("host")) return res.status(403).json({ message: "Hindi pinapayagan ang request na ito." }); } catch { return res.status(403).json({ message: "Hindi valid ang origin." }); }
  if (!req.is("application/json")) return res.status(415).json({ message: "JSON lang ang tinatanggap." });
  next();
});
const lim = (windowMs, limit) => rateLimit({ windowMs, limit, standardHeaders: true, legacyHeaders: false, message: { message: "Masyadong maraming request. Subukan ulit mamaya." } });
const authLimiter = lim(15 * 60e3, 12), orderLimiter = lim(10 * 60e3, 15), writeLimiter = lim(10 * 60e3, 10), readLimiter = lim(60e3, 60);

/* ---------- auth ---------- */
app.get("/api/health", (req, res) => res.json({ ok: true, service: "NOVA Panaderya API" }));
app.post("/api/auth/register", authLimiter, async (req, res) => {
  const name = clean(req.body.name), email = clean(req.body.email).toLowerCase(), password = String(req.body.password || "");
  if (name.length < 2 || name.length > 80) return res.status(400).json({ message: "Ilagay ang pangalan (2–80 characters)." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 190) return res.status(400).json({ message: "Valid na email ang kailangan." });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ message: "Ang password ay dapat 8–128 characters." });
  try {
    const role = process.env.ADMIN_EMAIL && email === process.env.ADMIN_EMAIL.trim().toLowerCase() ? "admin" : "customer";
    const info = db.prepare("INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,?)").run(name, email, await bcrypt.hash(password, 12), role);
    const user = db.prepare("SELECT id,name,email,role FROM users WHERE id=?").get(info.lastInsertRowid);
    req.session.regenerate(err => { if (err) return res.status(500).json({ message: "Hindi makapagsimula ng session." }); req.session.user = publicUser(user); res.status(201).json({ message: "Matagumpay ang registration at naka-login ka na.", user: req.session.user }); });
  } catch (e) { if (String(e.code).includes("SQLITE_CONSTRAINT")) return res.status(409).json({ message: "May account na gamit ang email na ito." }); res.status(500).json({ message: "Hindi makagawa ng account sa ngayon." }); }
});
app.post("/api/auth/login", authLimiter, async (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE email=?").get(clean(req.body.email).toLowerCase());
  if (!user || !(await bcrypt.compare(String(req.body.password || ""), user.password_hash))) return res.status(401).json({ message: "Mali ang email o password." });
  req.session.regenerate(err => { if (err) return res.status(500).json({ message: "Hindi makapagsimula ng session." }); req.session.user = publicUser(user); res.json({ message: "Matagumpay ang login.", user: req.session.user }); });
});
app.get("/api/auth/me", (req, res) => res.json({ user: currentUser(req) }));
app.post("/api/auth/logout", (req, res) => req.session.destroy(() => { res.clearCookie("nova.sid"); res.json({ message: "Naka-logout ka na." }); }));

/* ---------- public: menu, slots, shop, reviews, loyalty, tracking ---------- */
app.get("/api/state", readLimiter, (req, res) => {
  const today = dkey(manila()), slots = {};
  db.prepare("SELECT id,c FROM slots WHERE id>=?").all(today).forEach(r => slots[r.id] = r.c);
  const pay = getCfg("pay");
  res.json({
    menu: db.prepare("SELECT k,price AS p,stock AS s,hot FROM menu").all(), slots, shop: getCfg("shop"),
    pay: { num: pay.num, name: pay.name, qr: "" },
    reviews: db.prepare("SELECT n,s,t,at FROM reviews ORDER BY id DESC LIMIT 12").all()
  });
});
app.get("/api/menu", readLimiter, (req, res) => res.json({ items: db.prepare("SELECT k,name,price,stock,hot FROM menu").all() }));
app.get("/api/loyalty/:phone", readLimiter, (req, res) => {
  if (!/^9\d{9}$/.test(req.params.phone)) return res.status(400).json({ message: "Hindi valid ang numero." });
  const r = db.prepare("SELECT c FROM loyalty WHERE phone=?").get(req.params.phone); res.json({ c: r ? r.c : 0 });
});
app.get("/api/orders/:id/status", readLimiter, (req, res) => {
  const r = db.prepare("SELECT status FROM orders WHERE id=?").get(String(req.params.id).toUpperCase().slice(0, 40));
  if (!r) return res.status(404).json({ message: "Walang nakitang order." }); res.json({ status: r.status });
});
app.post("/api/reviews", writeLimiter, (req, res) => {
  const n = clean(req.body.n).slice(0, 60), t = clean(req.body.t).slice(0, 300), s = clean(req.body.s);
  if (n.length < 2 || t.length < 3 || !["★★★★★", "★★★★", "★★★"].includes(s)) return res.status(400).json({ message: "Ilagay ang pangalan at review." });
  db.prepare("INSERT INTO reviews(n,s,t,at) VALUES(?,?,?,?)").run(n, s, t, Date.now()); res.status(201).json({ message: "Salamat sa review!" });
});
app.post("/api/notify", writeLimiter, (req, res) => {
  const item = db.prepare("SELECT k,name FROM menu WHERE k=?").get(clean(req.body.k)), name = clean(req.body.n).slice(0, 80), ph = phone10(req.body.p);
  if (!item || name.length < 2 || !ph) return res.status(400).json({ message: "Ilagay ang pangalan at valid na PH cellphone number." });
  db.prepare("INSERT INTO notify(k,item,name,phone,at) VALUES(?,?,?,?,?)").run(item.k, item.name, name, "0" + ph, Date.now()); res.status(201).json({ message: "Sige! Ite-text ka namin." });
});

/* ---------- orders (server ang nagkakalkula ng presyo, promo, loyalty, stock, slot) ---------- */
app.post("/api/orders", orderLimiter, (req, res, next) => {
  try {
    const b = req.body || {}, name = clean(b.name).slice(0, 80), addr = clean(b.addr).slice(0, 250), ref = clean(b.ref).slice(0, 60);
    const mode = b.mode === "Delivery" ? "Delivery" : "Pickup", ph = phone10(b.phone), code = clean(b.promo).toUpperCase().slice(0, 20);
    if (name.length < 2) throw new HttpErr(400, "Ilagay ang pangalan.");
    if (!ph) throw new HttpErr(400, "Valid na PH cellphone number ang kailangan (09XXXXXXXXX).");
    if (mode === "Delivery" && addr.length < 5) throw new HttpErr(400, "Ilagay ang kumpletong address.");
    if (!["Cash pagdating", "GCash", "Maya"].includes(b.pay)) throw new HttpErr(400, "Hindi valid ang paraan ng bayad.");
    const days = nextDays(), di = days.findIndex(d => dkey(d) === b.dkey), slot = SLOTS.find(s => s.t === b.time);
    if (di < 0 || !slot) throw new HttpErr(400, "Hindi valid ang petsa o oras.");
    if (di === 0 && slot.m < days[0].getHours() * 60 + days[0].getMinutes() + 20) throw new HttpErr(400, "Lampas na ang oras na ito. Pumili ng ibang oras.");
    if (!Array.isArray(b.items) || !b.items.length || b.items.length > 30) throw new HttpErr(400, "Maglagay ng 1–30 menu items.");
    const want = new Map();
    for (const e of b.items) { const q = Number(e.q); if (!Number.isInteger(q) || q < 1 || q > 100) throw new HttpErr(400, "Hindi valid ang quantity."); want.set(clean(e.k), (want.get(clean(e.k)) || 0) + q); }

    const result = db.transaction(() => {
      const cfg = getCfg("shop"), sk = sid(b.dkey, slot.t);
      if ((db.prepare("SELECT c FROM slots WHERE id=?").get(sk) || { c: 0 }).c >= cfg.cap) throw new HttpErr(409, "Puno na ang oras na ito. Pumili ng iba.");
      const rows = []; let sub = 0;
      for (const [k, q] of want) {
        const m = db.prepare("SELECT k,name,price,stock FROM menu WHERE k=?").get(k);
        if (!m) throw new HttpErr(400, "May item na hindi available.");
        if (m.stock !== null && m.stock < q) throw new HttpErr(409, "Kulang ang stock ng " + m.name + ".");
        rows.push({ k, n: m.name, q, p: m.price, stock: m.stock }); sub += m.price * q;
      }
      const lc = (db.prepare("SELECT c FROM loyalty WHERE phone=?").get(ph) || { c: 0 }).c, dl = mode === "Delivery";
      let fee = dl ? (sub >= 300 ? 0 : 40) : 0, disc = 0;
      if (code === "NOVA10") {
        if (lc > 0 || db.prepare("SELECT COUNT(*) n FROM orders WHERE phone=? AND status!='Kanselado'").get(ph).n > 0) throw new HttpErr(400, "Para sa unang order lang ang NOVA10.");
        disc = Math.round(sub * .1);
      } else if (code === "BIYERNES") {
        if (!dl) throw new HttpErr(400, "Para sa delivery lang ang BIYERNES.");
        if (new Date(b.dkey + "T00:00:00").getDay() !== 5) throw new HttpErr(400, "Valid lang ang BIYERNES tuwing Biyernes.");
        fee = 0;
      } else if (code) throw new HttpErr(400, "Hindi valid ang promo code.");
      let free = 0;
      if (lc >= 9) { const c = rows.filter(r => r.k === "bun" || r.k === "pandesal").map(r => r.p); if (c.length) free = Math.min(...c); }
      const total = Math.max(0, sub + fee - disc - free), nc = lc >= 9 ? (free ? 0 : 9) : lc + 1;
      for (const r of rows) if (r.stock !== null && !db.prepare("UPDATE menu SET stock=stock-? WHERE k=? AND stock>=?").run(r.q, r.k, r.q).changes) throw new HttpErr(409, "Kulang ang stock ng " + r.n + ".");
      db.prepare("INSERT INTO slots(id,c) VALUES(?,1) ON CONFLICT(id) DO UPDATE SET c=c+1").run(sk);
      db.prepare("INSERT INTO loyalty(phone,c) VALUES(?,?) ON CONFLICT(phone) DO UPDATE SET c=excluded.c").run(ph, nc);
      const di2 = di, label = di2 === 0 ? "Ngayon" : di2 === 1 ? "Bukas" : days[di2].toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric" });
      const o = { id: "O" + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString("hex").toUpperCase(), n: name, p: "0" + ph, mode, time: slot.t, day: label, dkey: b.dkey,
        addr: dl ? addr : "", pay: b.pay, ref, promo: disc || (code === "BIYERNES") ? code : "", disc: disc + free, sub, fee, total, status: "Bago", at: Date.now(),
        items: rows.map(r => r.q + "× " + r.n + " (₱" + r.p * r.q + ")"), rows: rows.map(({ k, n, q, p }) => ({ k, n, q, p })) };
      const u = currentUser(req);
      db.prepare("INSERT INTO orders(id,user_id,phone,status,dkey,slot,total,data,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(o.id, u ? u.id : null, ph, o.status, o.dkey, o.time, o.total, JSON.stringify(o), o.at);
      return { order: o, loyalty: nc, free };
    })();
    res.status(201).json({ message: "Na-save ang order.", ...result });
  } catch (e) { next(e); }
});
const readOrder = r => ({ ...JSON.parse(r.data), status: r.status });
app.get("/api/orders", (req, res) => {
  const u = currentUser(req); if (!u) return res.status(401).json({ message: "Mag-login muna para magpatuloy." });
  res.json({ orders: db.prepare("SELECT data,status FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 30").all(u.id).map(readOrder) });
});

/* ---------- admin ---------- */
app.get("/api/admin/orders", requireAdmin, (req, res) => res.json({ orders: db.prepare("SELECT data,status FROM orders ORDER BY created_at DESC LIMIT 300").all().map(readOrder) }));
app.get("/api/admin/orders.csv", requireAdmin, (req, res) => {
  const q = v => { v = String(v ?? ""); if (/^[=+\-@]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; }; // iwas CSV/Excel formula injection
  const lines = [["Order No.", "Petsa", "Customer", "Cellphone", "Paraan", "Iskedyul", "Address", "Items", "Diskwento", "Kabuuan", "Bayad", "Ref", "Status"].join(",")];
  db.prepare("SELECT data,status FROM orders ORDER BY created_at DESC").all().map(readOrder).forEach(o =>
    lines.push([o.id, new Date(o.at).toISOString(), o.n, o.p, o.mode, o.day + " " + o.time, o.addr, o.items.join("; "), o.disc, o.total, o.pay, o.ref, o.status].map(q).join(",")));
  res.type("text/csv").set("Content-Disposition", 'attachment; filename="nova-orders.csv"').send("\ufeff" + lines.join("\r\n"));
});
app.patch("/api/admin/orders/:id", requireAdmin, (req, res) => {
  const st = req.body.status; if (!STATUSES.includes(st)) return res.status(400).json({ message: "Hindi valid ang order status." });
  const r = db.prepare("SELECT * FROM orders WHERE id=?").get(req.params.id); if (!r) return res.status(404).json({ message: "Hindi makita ang order." });
  if (r.status === "Kanselado" && st !== "Kanselado") return res.status(409).json({ message: "Hindi na maibabalik ang kanseladong order. Gumawa ng bagong order." });
  db.transaction(() => {
    if (st === "Kanselado" && r.status !== "Kanselado") { // ibalik ang stock at slot
      JSON.parse(r.data).rows.forEach(x => db.prepare("UPDATE menu SET stock=stock+? WHERE k=? AND stock IS NOT NULL").run(x.q, x.k));
      db.prepare("UPDATE slots SET c=MAX(0,c-1) WHERE id=?").run(sid(r.dkey, r.slot));
    }
    db.prepare("UPDATE orders SET status=? WHERE id=?").run(st, r.id);
  })();
  const o = JSON.parse(r.data);
  if (st === "Handa na") sendSms("0" + r.phone, `NOVA: Hi ${o.n}! Handa na ang order mo ${o.id}. Salamat!`);
  if (st === "Kanselado") sendSms("0" + r.phone, `NOVA: Kinansela ang order mo ${o.id}. Makipag-ugnayan sa tindahan para sa tanong.`);
  res.json({ message: "Na-update ang status." });
});
app.put("/api/admin/menu", requireAdmin, (req, res) => {
  const list = req.body.items; if (!Array.isArray(list) || list.length > 100) return res.status(400).json({ message: "Hindi valid ang menu data." });
  const restocked = [];
  try {
    db.transaction(() => list.forEach(x => {
      const p = Number(x.p), s = x.s === null ? null : Number(x.s), old = db.prepare("SELECT stock FROM menu WHERE k=?").get(clean(x.k));
      if (!old) throw new HttpErr(404, "Hindi makita ang menu item.");
      if (!Number.isFinite(p) || p < 0 || (s !== null && (!Number.isInteger(s) || s < 0))) throw new HttpErr(400, "Hindi valid ang presyo o stock.");
      db.prepare("UPDATE menu SET price=?,stock=?,hot=? WHERE k=?").run(p, s, x.hot ? 1 : 0, clean(x.k));
      if (old.stock === 0 && s > 0) restocked.push(clean(x.k));
    }))();
  } catch (e) { return res.status(e.s || 500).json({ message: e.s ? e.message : "Hindi na-save ang menu." }); }
  restocked.forEach(k => db.prepare("SELECT * FROM notify WHERE k=? AND done=0").all(k).forEach(n => { // awtomatikong abiso kapag may stock na ulit
    sendSms(n.phone, `NOVA: Hi ${n.name}! May ${n.item} na ulit. Order na!`); db.prepare("UPDATE notify SET done=1 WHERE id=?").run(n.id); }));
  res.json({ message: "Na-update ang menu." });
});
app.put("/api/admin/config/:key", requireAdmin, (req, res) => {
  const b = req.body, https = v => (/^https:\/\/\S{3,300}$/.test(clean(v)) ? clean(v) : "");
  if (req.params.key === "shop") {
    const sp = clean(b.sp), cap = Number(b.cap);
    if (sp && !db.prepare("SELECT 1 FROM menu WHERE k=?").get(sp)) return res.status(400).json({ message: "Hindi valid ang special." });
    setCfg("shop", { cap: Number.isInteger(cap) && cap >= 1 && cap <= 200 ? cap : 10, sp, fb: https(b.fb), ig: https(b.ig), tt: https(b.tt) });
  } else if (req.params.key === "pay") setCfg("pay", { num: clean(b.num).slice(0, 40), name: clean(b.name).slice(0, 80), qr: "" });
  else return res.status(404).json({ message: "Hindi makita ang setting." });
  res.json({ message: "Na-save." });
});
app.get("/api/admin/notify", requireAdmin, (req, res) => res.json({ items: db.prepare("SELECT id,k,item,name AS n,phone AS p,at,done FROM notify ORDER BY id DESC LIMIT 100").all().map(x => ({ ...x, done: !!x.done })) }));
app.patch("/api/admin/notify/:id", requireAdmin, (req, res) => { db.prepare("UPDATE notify SET done=1 WHERE id=?").run(Number(req.params.id)); res.json({ message: "OK" }); });

/* ---------- static / errors ---------- */
app.use("/api", (req, res) => res.status(404).json({ message: "Hindi makita ang API route." }));
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.use((err, req, res, next) => {
  const s = err.s || err.status || 500; if (s >= 500) console.error(err);
  res.status(s).json({ message: s >= 500 ? "May problema sa server. Subukan ulit mamaya." : err.message });
});
app.listen(PORT, () => console.log(`NOVA Panaderya running at http://localhost:${PORT}`));
