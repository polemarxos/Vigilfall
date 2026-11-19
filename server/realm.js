// Vigilfall Realm server: WebSocket relay + cloud saves + admin API + headless world host supervisor.
// Run: node realm.js   (config in data/config.json, created on first start)
"use strict";
const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");

const ROOT = __dirname;
const DATA = process.env.VF_DATA || path.join(ROOT, "data");
const PLAYERS = path.join(DATA, "players");
const BACKUPS = path.join(DATA, "backups");
const GAME = path.join(ROOT, "game");
for (const d of [DATA, PLAYERS, BACKUPS, GAME]) fs.mkdirSync(d, { recursive: true });

// ---------------- config ----------------
const CFG_FILE = path.join(DATA, "config.json");
const rnd = (n) => crypto.randomBytes(n).toString("base64url").slice(0, n);
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CFG_FILE, "utf8")); } catch (e) {}
cfg = Object.assign(
  {
    name: "Vigilfall Realm",
    motd: "Welcome to the Realm!",
    port: 8787,
    bind: "127.0.0.1",
    maxPlayers: 80,
    adminPassword: process.env.VF_ADMIN_PASSWORD || rnd(14),
    hostToken: rnd(24),
    gameUrl: "https://polemarxos.github.io/Vigilfall/",
    autoUpdate: true,
    range: 140,
  },
  cfg,
);
const saveCfg = () => fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));
saveCfg();
if (process.env.VF_PORT) cfg.port = +process.env.VF_PORT;

// ---------------- log ----------------
const LOG = [];
const log = (...a) => {
  const line = new Date().toISOString().slice(0, 19).replace("T", " ") + " " + a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  console.log(line);
  LOG.push(line);
  LOG.length > 600 && LOG.splice(0, LOG.length - 600);
};

// ---------------- player records (one JSON file each) ----------------
const okPid = (p) => typeof p === "string" && /^[A-Za-z0-9-]{4,24}$/.test(p);
const recFile = (pid) => path.join(PLAYERS, pid + ".json");
const recs = new Map(); // pid -> record (profile kept on disk, summary in memory)
const summaryOf = (p) => {
  const hs = Object.values(p?.heroes || {});
  return {
    lv: hs.reduce((a, h) => Math.max(a, h?.level || 1), 1),
    heroes: hs.length,
    shards: p?.shards || 0,
    marks: p?.marks || 0,
    victory: !!p?.campaign?.victory,
  };
};
for (const f of fs.readdirSync(PLAYERS)) {
  if (!f.endsWith(".json")) continue;
  try {
    const r = JSON.parse(fs.readFileSync(path.join(PLAYERS, f), "utf8"));
    const { profile, ...meta } = r;
    meta.sum = summaryOf(profile);
    recs.set(r.pid, meta);
  } catch (e) {
    log("bad record", f, e.message);
  }
}
const readRec = async (pid) => {
  try { return JSON.parse(await fsp.readFile(recFile(pid), "utf8")); } catch (e) { return null; }
};
const writing = new Map();
const writeRec = async (r) => {
  // serialise writes per player; write to a temp file first so a crash never leaves half a save
  const prev = writing.get(r.pid) || Promise.resolve();
  const job = prev.then(async () => {
    const tmp = recFile(r.pid) + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(r));
    await fsp.rename(tmp, recFile(r.pid));
  }).catch((e) => log("write failed", r.pid, e.message));
  writing.set(r.pid, job);
  const { profile, ...meta } = r;
  meta.sum = summaryOf(profile);
  recs.set(r.pid, meta);
  return job;
};
const backup = async (r, why) => {
  if (!r?.profile) return;
  const dir = path.join(BACKUPS, r.pid);
  await fsp.mkdir(dir, { recursive: true });
  const name = Date.now() + "-" + why + ".json";
  await fsp.writeFile(path.join(dir, name), JSON.stringify(r.profile));
  const all = (await fsp.readdir(dir)).sort();
  for (const f of all.slice(0, Math.max(0, all.length - 20))) await fsp.unlink(path.join(dir, f)).catch(() => {});
};
const hash = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

// ---------------- world host (headless browser) ----------------
const H = { ws: null, ready: false, ver: null, stat: null, statAt: 0, child: null, startedAt: 0, restarts: 0, wantStop: false };
const startHost = () => {
  if (H.child) return;
  if (!fs.existsSync(path.join(GAME, "index.html"))) {
    log("no game file yet; downloading first");
    return updateGame(true).then(() => setTimeout(startHost, 1000));
  }
  H.startedAt = Date.now();
  H.statAt = Date.now();
  const env = { ...process.env, VF_PORT: String(cfg.port), VF_TOKEN: cfg.hostToken, VF_MAX: String(cfg.maxPlayers), VF_RANGE: String(cfg.range), VF_DATA: DATA };
  const c = spawn(process.execPath, [path.join(ROOT, "host.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  H.child = c;
  log("world host starting (pid " + c.pid + ")");
  const pipe = (s) => s.on("data", (d) => String(d).split("\n").filter(Boolean).forEach((l) => log("[host] " + l.slice(0, 400))));
  pipe(c.stdout);
  pipe(c.stderr);
  c.on("exit", (code) => {
    log("world host exited", code);
    H.child = null;
    H.ready = false;
    if (!H.wantStop) {
      H.restarts++;
      setTimeout(startHost, 3000);
    }
    H.wantStop = false;
  });
};
const restartHost = (why) => {
  log("restarting world host: " + why);
  H.ready = false;
  if (H.child) {
    try { H.child.kill("SIGTERM"); } catch (e) {}
    const c = H.child;
    setTimeout(() => { try { c.exitCode === null && c.kill("SIGKILL"); } catch (e) {} }, 8000);
  } else startHost();
};
// a stuck world (no stats for 90 s) gets restarted
setInterval(() => {
  if (H.child && Date.now() - H.statAt > 90e3 && Date.now() - H.startedAt > 240e3) restartHost("no heartbeat");
}, 15e3);

// ---------------- game updates from GitHub Pages ----------------
let gameVer = null;
try { gameVer = fs.readFileSync(path.join(GAME, "version.txt"), "utf8").trim(); } catch (e) {}
let updating = false;
async function updateGame(force) {
  if (updating) return { ok: false, why: "busy" };
  updating = true;
  try {
    const base = cfg.gameUrl.replace(/\/?$/, "/");
    const v = (await (await fetch(base + "version.txt?t=" + Date.now())).text()).trim();
    if (!force && v === gameVer) return { ok: true, same: true, ver: v };
    const r = await fetch(base + "index.html?t=" + Date.now());
    if (!r.ok) throw new Error("download " + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1e6) throw new Error("file too small");
    await fsp.writeFile(path.join(GAME, "index.html.tmp"), buf);
    await fsp.rename(path.join(GAME, "index.html.tmp"), path.join(GAME, "index.html"));
    await fsp.writeFile(path.join(GAME, "version.txt"), v);
    const old = gameVer;
    gameVer = v;
    log("game updated", old, "->", v);
    return { ok: true, ver: v, changed: true };
  } catch (e) {
    log("update failed", e.message);
    return { ok: false, why: e.message };
  } finally {
    updating = false;
  }
}
async function updateAndRestart(manual) {
  const r = await updateGame(false);
  if (r.changed && H.child) {
    announce(`The Realm restarts in 60 seconds for update ${r.ver}.`, "Realm");
    setTimeout(() => restartHost("update " + r.ver), 60e3);
  }
  return r;
}
setInterval(() => cfg.autoUpdate && updateAndRestart(false), 10 * 60e3);

// ---------------- clients ----------------
const clients = new Map(); // id (vigilfall peer id) -> client
const PFX = "vigilfall-v1-";
const sendJ = (ws, m) => { try { ws.readyState === 1 && ws.send(typeof m === "string" ? m : JSON.stringify(m)); } catch (e) {} };
const hsend = (f) => H.ws && sendJ(H.ws, f);
function announce(text, from) {
  const s = JSON.stringify({ t: "announce", text: String(text).slice(0, 300), from: from || "Admin" });
  for (const c of clients.values()) c.authed && sendJ(c.ws, s);
  log("announce:", text);
}
function kick(id, why) {
  const c = clients.get(id);
  if (!c) return false;
  sendJ(c.ws, { t: "kicked", why });
  setTimeout(() => { try { c.ws.close(4001, "kicked"); } catch (e) {} }, 200);
  return true;
}
const clientOfPid = (pid) => [...clients.values()].find((c) => c.pid === pid);
const fails = new Map();

async function onClientMsg(c, m) {
  if (!c.authed) {
    if (m.t !== "auth") return;
    const pid = String(m.pid || ""), key = String(m.key || "");
    if (!okPid(pid) || key.length < 16) return sendJ(c.ws, { t: "denied", why: "Bad login data." });
    if (!H.ready || !H.ws) return sendJ(c.ws, { t: "denied", why: "The Realm is starting. Try again in a minute.", retry: true });
    if ([...clients.values()].filter((x) => x.authed).length >= cfg.maxPlayers) return sendJ(c.ws, { t: "full" });
    let r = await readRec(pid);
    if (r?.banned) return sendJ(c.ws, { t: "denied", why: "You are banned from this Realm" + (r.banReason ? ": " + r.banReason : ".") });
    if (r && r.keyHash && r.keyHash !== hash(key)) return sendJ(c.ws, { t: "denied", why: "This character is linked to another device. Ask the Realm admin to reset it." });
    const now = Date.now();
    if (!r) r = { pid, created: now, adminRev: 0 };
    r.keyHash ||= hash(key);
    Object.assign(r, { name: String(m.name || "Wanderer").slice(0, 20), lastSeen: now, ver: String(m.ver || ""), hero: m.hero || r.hero, ip: c.ip });
    await writeRec(r);
    // one session per character
    const old = clientOfPid(pid);
    old && old !== c && kick(old.id, "You logged in somewhere else.");
    c.authed = true;
    c.pid = pid;
    c.id = PFX + pid;
    c.name = r.name;
    c.since = now;
    c.ver = r.ver;
    c.lv = m.lv;
    c.hero = m.hero;
    clients.delete(c.tmpId);
    clients.set(c.id, c);
    sendJ(c.ws, { t: "_info", motd: cfg.motd, ver: H.ver || gameVer, name: cfg.name, online: clients.size });
    if (r.profile && (r.adminRev || 0) > (+m.rev || 0)) sendJ(c.ws, { t: "cloud", p: r.profile, rev: r.adminRev });
    hsend({ o: "open", id: c.id, pid, name: c.name });
    log("join", pid, c.name, c.ip);
    return;
  }
  if (m.t === "_save") {
    const p = m.p;
    if (!p || typeof p !== "object" || !p.heroes || !p.campaign) return;
    const r = (await readRec(c.pid)) || { pid: c.pid, created: Date.now(), adminRev: 0 };
    if ((r.adminRev || 0) > (p.adminRev || 0) && r.profile) return sendJ(c.ws, { t: "cloud", p: r.profile, rev: r.adminRev });
    const hourly = !r.lastBackup || Date.now() - r.lastBackup > 3600e3;
    if (hourly && r.profile) (await backup(r, "auto"), (r.lastBackup = Date.now()));
    delete p.ckey;
    r.profile = p;
    r.savedAt = Date.now();
    r.lastSeen = Date.now();
    r.name = String(p.name || r.name).slice(0, 20);
    c.name = r.name;
    c.lv = summaryOf(p).lv;
    await writeRec(r);
    return;
  }
  if (m.t === "me") (c.lv = m.lv), (c.hero = m.hero), (c.pos = m.p);
  hsend({ o: "msg", id: c.id, m });
}

// ---------------- HTTP: health, admin page, admin API ----------------
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS" };
const json = (res, code, o) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS });
  res.end(JSON.stringify(o));
};
const body = (req) =>
  new Promise((ok, bad) => {
    let n = 0;
    const ch = [];
    req.on("data", (d) => {
      n += d.length;
      if (n > 8e6) (bad(new Error("too big")), req.destroy());
      else ch.push(d);
    });
    req.on("end", () => {
      try { ok(ch.length ? JSON.parse(Buffer.concat(ch).toString("utf8")) : {}); } catch (e) { bad(e); }
    });
  });
const ipOf = (req) => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
const authed = (req) => {
  const ip = ipOf(req);
  const f = fails.get(ip);
  if (f && f.n >= 10 && Date.now() - f.t < 10 * 60e3) return "locked";
  const h = String(req.headers.authorization || "");
  const pw = h.startsWith("Bearer ") ? h.slice(7) : "";
  const a = Buffer.from(hash(pw)), b = Buffer.from(hash(cfg.adminPassword));
  if (pw && crypto.timingSafeEqual(a, b)) return true;
  fails.set(ip, { n: (f && Date.now() - f.t < 10 * 60e3 ? f.n : 0) + 1, t: Date.now() });
  return false;
};
const onlineList = () =>
  [...clients.values()].filter((c) => c.authed).map((c) => ({ pid: c.pid, name: c.name, lv: c.lv, hero: c.hero, ip: c.ip, since: c.since, ver: c.ver, pos: c.pos ? [Math.round(c.pos[0]), Math.round(c.pos[2])] : null }));

async function api(req, res, url) {
  const ok = authed(req);
  if (ok === "locked") return json(res, 429, { error: "Too many wrong passwords. Wait 10 minutes." });
  if (!ok) return json(res, 401, { error: "Wrong admin password." });
  fails.delete(ipOf(req));
  const p = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const M = req.method;
  const online = new Set([...clients.values()].filter((c) => c.authed).map((c) => c.pid));
  if (p[0] === "status" && M === "GET") {
    const mem = process.memoryUsage();
    return json(res, 200, {
      name: cfg.name, motd: cfg.motd, maxPlayers: cfg.maxPlayers, autoUpdate: cfg.autoUpdate, gameUrl: cfg.gameUrl,
      gameVersion: gameVer, hostVersion: H.ver, hostUp: !!H.child, hostReady: H.ready, hostSince: H.startedAt, restarts: H.restarts,
      world: H.stat, uptime: Math.round(process.uptime()), load: os.loadavg(), cpus: os.cpus().length,
      mem: { total: os.totalmem(), free: os.freemem(), server: mem.rss }, players: recs.size, online: onlineList(),
    });
  }
  if (p[0] === "players" && !p[1] && M === "GET") {
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const list = [...recs.values()]
      .filter((r) => !q || r.pid.toLowerCase().includes(q) || String(r.name || "").toLowerCase().includes(q))
      .map((r) => ({ pid: r.pid, name: r.name, lastSeen: r.lastSeen, created: r.created, banned: !!r.banned, online: online.has(r.pid), ...r.sum, hero: r.hero, ver: r.ver }))
      .sort((a, b) => b.online - a.online || (b.lastSeen || 0) - (a.lastSeen || 0));
    return json(res, 200, { players: list });
  }
  if (p[0] === "players" && p[1]) {
    const pid = p[1];
    if (!okPid(pid)) return json(res, 400, { error: "bad id" });
    const r = await readRec(pid);
    if (!r) return json(res, 404, { error: "No such player." });
    const act = p[2];
    if (!act && M === "GET") {
      const { keyHash, ...rest } = r;
      return json(res, 200, { ...rest, locked: !!keyHash, online: online.has(pid) });
    }
    if (!act && M === "PUT") {
      const b = await body(req);
      const prof = b.profile;
      if (!prof || typeof prof !== "object" || !prof.heroes || !prof.campaign) return json(res, 400, { error: "That is not a Vigilfall save (heroes/campaign missing)." });
      await backup(r, "before-edit");
      r.adminRev = (r.adminRev || 0) + 1;
      prof.adminRev = r.adminRev;
      delete prof.ckey;
      r.profile = prof;
      r.name = String(prof.name || r.name).slice(0, 20);
      r.editedAt = Date.now();
      await writeRec(r);
      const c = clientOfPid(pid);
      c && sendJ(c.ws, { t: "cloud", p: prof, rev: r.adminRev });
      log("admin edited save", pid, c ? "(pushed live)" : "(applies on next login)");
      return json(res, 200, { ok: true, rev: r.adminRev, live: !!c });
    }
    if (act === "kick" && M === "POST") {
      const b = await body(req).catch(() => ({}));
      const c = clientOfPid(pid);
      return json(res, 200, { ok: !!(c && kick(c.id, b.why || "Removed by an admin.")) });
    }
    if (act === "ban" && M === "POST") {
      const b = await body(req).catch(() => ({}));
      r.banned = true;
      r.banReason = String(b.why || "").slice(0, 200);
      await writeRec(r);
      const c = clientOfPid(pid);
      c && kick(c.id, "Banned" + (r.banReason ? ": " + r.banReason : ""));
      log("ban", pid, r.banReason);
      return json(res, 200, { ok: true });
    }
    if (act === "unban" && M === "POST") {
      r.banned = false;
      delete r.banReason;
      await writeRec(r);
      log("unban", pid);
      return json(res, 200, { ok: true });
    }
    if (act === "resetkey" && M === "POST") {
      delete r.keyHash;
      await writeRec(r);
      log("device link reset", pid);
      return json(res, 200, { ok: true });
    }
    if (act === "backups" && M === "GET") {
      const dir = path.join(BACKUPS, pid);
      let files = [];
      try { files = (await fsp.readdir(dir)).sort().reverse(); } catch (e) {}
      if (p[3]) {
        if (!files.includes(p[3])) return json(res, 404, { error: "no such backup" });
        return json(res, 200, JSON.parse(await fsp.readFile(path.join(dir, p[3]), "utf8")));
      }
      return json(res, 200, { backups: files.map((f) => ({ file: f, at: +f.split("-")[0], why: f.split("-").slice(1).join("-").replace(/\.json$/, "") })) });
    }
    if (act === "restore" && M === "POST") {
      const b = await body(req);
      const f = path.basename(String(b.file || ""));
      let prof;
      try { prof = JSON.parse(await fsp.readFile(path.join(BACKUPS, pid, f), "utf8")); } catch (e) { return json(res, 404, { error: "no such backup" }); }
      await backup(r, "before-restore");
      r.adminRev = (r.adminRev || 0) + 1;
      prof.adminRev = r.adminRev;
      r.profile = prof;
      await writeRec(r);
      const c = clientOfPid(pid);
      c && sendJ(c.ws, { t: "cloud", p: prof, rev: r.adminRev });
      log("restored backup", pid, f);
      return json(res, 200, { ok: true, live: !!c });
    }
    if (!act && M === "DELETE") {
      const c = clientOfPid(pid);
      c && kick(c.id, "Your Realm character was removed.");
      await backup(r, "deleted");
      await fsp.unlink(recFile(pid)).catch(() => {});
      recs.delete(pid);
      log("deleted player", pid);
      return json(res, 200, { ok: true });
    }
  }
  if (p[0] === "announce" && M === "POST") {
    const b = await body(req);
    if (!b.text) return json(res, 400, { error: "empty" });
    announce(b.text, b.from || "Admin");
    return json(res, 200, { ok: true, sent: clients.size });
  }
  if (p[0] === "config" && M === "POST") {
    const b = await body(req);
    if (typeof b.name === "string") cfg.name = b.name.slice(0, 40);
    if (typeof b.motd === "string") cfg.motd = b.motd.slice(0, 200);
    if (b.maxPlayers) cfg.maxPlayers = Math.max(1, Math.min(300, +b.maxPlayers | 0));
    if (typeof b.autoUpdate === "boolean") cfg.autoUpdate = b.autoUpdate;
    if (typeof b.newPassword === "string") {
      if (b.newPassword.length < 8) return json(res, 400, { error: "Password must be at least 8 characters." });
      cfg.adminPassword = b.newPassword;
    }
    saveCfg();
    log("config changed");
    return json(res, 200, { ok: true });
  }
  if (p[0] === "restart" && M === "POST") {
    const b = await body(req).catch(() => ({}));
    const delay = Math.max(0, Math.min(600, +b.delay || 0));
    delay && announce(`The Realm restarts in ${delay} seconds.`, "Realm");
    setTimeout(() => restartHost("admin"), delay * 1000);
    return json(res, 200, { ok: true });
  }
  if (p[0] === "update" && M === "POST") return json(res, 200, await updateAndRestart(true));
  if (p[0] === "log" && M === "GET") return json(res, 200, { lines: LOG.slice(-300) });
  return json(res, 404, { error: "unknown call" });
}

const ADMIN_HTML = path.join(ROOT, "admin", "index.html");
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "OPTIONS") return (res.writeHead(204, CORS), res.end());
    if (url.pathname === "/health") return json(res, 200, { ok: true, name: cfg.name, online: [...clients.values()].filter((c) => c.authed).length, max: cfg.maxPlayers, ver: H.ver || gameVer, ready: H.ready });
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return fs.createReadStream(ADMIN_HTML).pipe(res);
    }
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html><meta name=viewport content="width=device-width"><body style="background:#111;color:#e8dcc0;font-family:sans-serif;text-align:center;padding-top:20vh"><h1>${cfg.name}</h1><p>This is a Vigilfall Realm server. Play at <a style="color:#ffd070" href="${cfg.gameUrl}">${cfg.gameUrl}</a> and press <b>Enter the Realm</b>.</p><p><a style="color:#9ad0ff" href="/admin">Admin</a></p>`);
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    log("http error", e.message);
    json(res, 500, { error: e.message });
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 6e6 });
server.on("upgrade", (req, sock, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/host") {
    const local = /^(::ffff:)?127\.0\.0\.1$|^::1$/.test(req.socket.remoteAddress || "");
    if (!local || url.searchParams.get("token") !== cfg.hostToken) return sock.destroy();
    return wss.handleUpgrade(req, sock, head, (ws) => onHost(ws));
  }
  if (url.pathname === "/realm") return wss.handleUpgrade(req, sock, head, (ws) => onClient(ws, req));
  sock.destroy();
});

let tmpN = 0;
function onClient(ws, req) {
  const c = { ws, ip: ipOf(req), authed: false, tmpId: "tmp" + ++tmpN, n: 0, t0: Date.now() };
  clients.set(c.tmpId, c);
  ws.on("message", (d) => {
    // simple flood guard: 120 messages per second at most
    const now = Date.now();
    if (now - c.t0 > 1000) (c.t0 = now), (c.n = 0);
    if (++c.n > 120) return;
    let m;
    try { m = JSON.parse(d); } catch (e) { return; }
    if (m && typeof m === "object") onClientMsg(c, m).catch((e) => log("client msg error", e.message));
  });
  ws.on("close", () => {
    if (clients.get(c.id) === c) {
      clients.delete(c.id);
      hsend({ o: "close", id: c.id });
      c.authed && log("leave", c.pid, c.name);
    }
    clients.delete(c.tmpId);
  });
  ws.on("error", () => {});
  setTimeout(() => !c.authed && ws.close(), 20e3);
}
function onHost(ws) {
  if (H.ws) try { H.ws.close(); } catch (e) {}
  H.ws = ws;
  log("world host connected");
  ws.on("message", (d) => {
    let f;
    try { f = JSON.parse(d); } catch (e) { return; }
    if (f.o === "to") {
      const c = clients.get(f.id);
      process.env.VF_DEBUG && f.m.t !== "snap" && log("to", f.id, f.m.t, !!c, c && c.authed, c && c.ws.readyState);
      c?.authed && sendJ(c.ws, f.m);
    } else if (f.o === "all") {
      const s = JSON.stringify(f.m);
      for (const c of clients.values()) c.authed && c.id !== f.ex && sendJ(c.ws, s);
    } else if (f.o === "kick") {
      const c = clients.get(f.id);
      c && setTimeout(() => { try { c.ws.close(); } catch (e) {} }, 300);
    } else if (f.o === "ready") {
      if (f.ok && !H.ready) log("world ready", f.ver);
      H.ready = !!f.ok;
      H.ver = f.ver || H.ver;
    } else if (f.o === "stat") {
      H.stat = f;
      H.statAt = Date.now();
    } else if (f.o === "fatal") {
      log("world failed:", f.why);
      restartHost("fatal");
    }
  });
  ws.on("close", () => {
    if (H.ws !== ws) return;
    H.ws = null;
    H.ready = false;
    log("world host disconnected; dropping players (they reconnect)");
    for (const c of [...clients.values()]) try { c.ws.close(4000, "realm restarting"); } catch (e) {}
  });
  ws.on("error", () => {});
}

server.listen(cfg.port, cfg.bind, () => {
  log(`Vigilfall Realm listening on ${cfg.bind}:${cfg.port}`);
  log(`Admin password is in ${CFG_FILE}`);
  if (process.env.VF_NOHOST !== "1") startHost();
  cfg.autoUpdate && setTimeout(() => updateAndRestart(false), 20e3);
});
const bye = () => {
  H.wantStop = true;
  try { H.child?.kill("SIGTERM"); } catch (e) {}
  setTimeout(() => process.exit(0), 1500);
};
process.on("SIGTERM", bye);
process.on("SIGINT", bye);
