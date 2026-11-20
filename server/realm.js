// Vigilfall Realm server: WebSocket relay + cloud saves + admin API + headless world host supervisor.
// Run: node realm.js   (config in data/config.json, created on first start)
"use strict";
const SERVER_VERSION = "1.7.0";
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
    autoBackupHours: 6,
    autoBackupKeep: 10,
    maintenance: false,
    antiCheat: true,
    cheatTolerance: 1,
    maintenanceMsg: "The Realm is closed for maintenance. Please come back soon.",
    adminPassword: process.env.VF_ADMIN_PASSWORD || rnd(14),
    hostToken: rnd(24),
    gameUrl: "https://polemarxos.github.io/Vigilfall/",
    autoUpdate: true,
    updateMinutes: 10,
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
const byName = new Map(); // account name (lower case) -> pid
const loadRecs = () => {
recs.clear();
byName.clear();
for (const f of fs.readdirSync(PLAYERS)) {
  if (!f.endsWith(".json")) continue;
  try {
    const r = JSON.parse(fs.readFileSync(path.join(PLAYERS, f), "utf8"));
    const { profile, ...meta } = r;
    meta.sum = summaryOf(profile);
    recs.set(r.pid, meta);
    r.acct && byName.set(r.acct, r.pid);
  } catch (e) {
    log("bad record", f, e.message);
  }
}
};
loadRecs();
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
  // refused (anti-cheat) saves are kept apart, so a flood of them never pushes out the good backups
  const all = (await fsp.readdir(dir)).sort(), bad = all.filter((f) => f.includes("-refused")), good = all.filter((f) => !f.includes("-refused"));
  for (const f of [...good.slice(0, Math.max(0, good.length - 20)), ...bad.slice(0, Math.max(0, bad.length - 5))]) await fsp.unlink(path.join(dir, f)).catch(() => {});
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
  // a running world that stops reporting is stuck; a world that is still building gets 20 minutes (slow servers)
  if (H.child && H.ready && Date.now() - H.statAt > 90e3) restartHost("no heartbeat");
  else if (H.child && !H.ready && Date.now() - H.startedAt > 20 * 60e3) restartHost("world did not start in 20 minutes");
}, 15e3);

// ---------------- game updates from GitHub Pages ----------------
let gameVer = null;
try { gameVer = fs.readFileSync(path.join(GAME, "version.txt"), "utf8").trim(); } catch (e) {}
let updating = false;
// ---------------- where everything comes from: the GitHub repository (works private too, with a read token) ----------------
const SRC_FILE = path.join(DATA, "source.json"); // apart from config.json: the token never goes into a backup
let src = { repo: "polemarxos/Vigilfall", branch: "main", token: "", last: null };
try { Object.assign(src, JSON.parse(fs.readFileSync(SRC_FILE, "utf8"))); } catch (e) {}
const saveSrc = () => fs.writeFileSync(SRC_FILE, JSON.stringify(src, null, 2), { mode: 0o600 });
async function srcGet(file, opt = {}) {
  // with a token: the GitHub API (private repos, up to 100 MB a file); without: the public raw address
  const url = src.token
    ? `https://api.github.com/repos/${src.repo}/contents/${file.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(src.branch)}&t=${Date.now()}`
    : `https://raw.githubusercontent.com/${src.repo}/${src.branch}/${file}?t=${Date.now()}`;
  const headers = src.token ? { Authorization: "Bearer " + src.token, Accept: "application/vnd.github.raw", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "vigilfall-realm" } : {};
  const r = await fetch(url, { headers });
  if (r.status === 404 && opt.optional) return null;
  if (r.status === 404) throw new Error(src.token ? `${file} not found in ${src.repo} (or the token cannot read it)` : `${file} not found — if the repository is private, add a read token (Server → Game source)`);
  if (r.status === 401 || r.status === 403) throw new Error("GitHub refused the game-source token (wrong, expired or no access).");
  if (!r.ok) throw new Error(`download ${file}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
// files the server hands out to players (the game, its app files and both Android apps)
const PUBLIC_FILES = ["index.html", "version.txt", "manifest.webmanifest", "sw.js", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png", "Vigilfall.apk", "VigilfallAdmin.apk", "VigilfallAdmin.json"];
let adminAppInfo = null;
try { adminAppInfo = JSON.parse(fs.readFileSync(path.join(GAME, "VigilfallAdmin.json"), "utf8")); } catch (e) {}
const putGame = async (name, buf) => {
  await fsp.writeFile(path.join(GAME, name + ".tmp"), buf);
  await fsp.rename(path.join(GAME, name + ".tmp"), path.join(GAME, name));
};
async function updateGame(force) {
  if (updating) return { ok: false, why: "busy" };
  updating = true;
  try {
    const v = String(await srcGet("version.txt")).trim();
    // the admin app can change without a new game version
    const ai = await srcGet("VigilfallAdmin.json", { optional: true });
    if (ai) {
      const j = JSON.parse(String(ai));
      if (!adminAppInfo || j.versionCode !== adminAppInfo.versionCode || !fs.existsSync(path.join(GAME, "VigilfallAdmin.apk"))) {
        const apk = await srcGet("VigilfallAdmin.apk", { optional: true });
        if (apk) await putGame("VigilfallAdmin.apk", apk);
        await putGame("VigilfallAdmin.json", ai);
        adminAppInfo = j;
        log("admin app", j.versionName, "ready for download");
      }
    }
    src.last = { at: Date.now(), ok: true, ver: v };
    saveSrc();
    if (!force && v === gameVer && fs.existsSync(path.join(GAME, "index.html"))) return { ok: true, same: true, ver: v };
    const html = await srcGet("index.html");
    if (html.length < 1e6) throw new Error("index.html too small");
    for (const f of PUBLIC_FILES) {
      if (f === "index.html" || f === "version.txt" || f.startsWith("VigilfallAdmin")) continue;
      try { const b = await srcGet(f, { optional: true }); b && (await putGame(f, b)); } catch (e) { log("could not get", f, e.message); }
    }
    await putGame("index.html", html);
    await putGame("version.txt", Buffer.from(v));
    const old = gameVer;
    gameVer = v;
    log("game updated", old, "->", v);
    return { ok: true, ver: v, changed: true };
  } catch (e) {
    src.last = { at: Date.now(), ok: false, error: e.message };
    try { saveSrc(); } catch (er) {}
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
// automatic update checks, every cfg.updateMinutes (changeable from the admin app)
let updTimer = null, lastCheck = 0, nextCheck = 0;
const scheduleUpdates = () => {
  clearTimeout(updTimer);
  if (!cfg.autoUpdate) return (nextCheck = 0);
  const ms = Math.max(1, Math.min(1440, +cfg.updateMinutes || 10)) * 60e3;
  nextCheck = Date.now() + ms;
  updTimer = setTimeout(async () => {
    lastCheck = Date.now();
    try { await updateAndRestart(false); } catch (e) {}
    scheduleUpdates();
  }, ms);
};

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
    const sess = sessions[String(m.token || "")];
    if (!sess || sess.exp < Date.now()) return sendJ(c.ws, { t: "denied", why: m.token ? "Your sign-in has expired. Sign in again." : "Please update Vigilfall: the Realm now uses accounts." });
    const pid = sess.pid;
    if (cfg.maintenance) return sendJ(c.ws, { t: "denied", why: cfg.maintenanceMsg || "The Realm is closed for maintenance." });
    if (!H.ready || !H.ws) return sendJ(c.ws, { t: "denied", why: "The Realm is starting. Try again in a minute.", retry: true });
    if ([...clients.values()].filter((x) => x.authed).length >= cfg.maxPlayers) return sendJ(c.ws, { t: "full" });
    let r = await readRec(pid);
    if (!r) return sendJ(c.ws, { t: "denied", why: "This account no longer exists." });
    if (r?.banned) return sendJ(c.ws, { t: "denied", why: "You are banned from this Realm" + (r.banReason ? ": " + r.banReason : ".") });
    const now = Date.now();
    Object.assign(r, { lastSeen: now, ver: String(m.ver || ""), hero: m.hero || r.hero, ip: c.ip });
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
    hsend({ o: "open", id: c.id, pid, name: c.name });
    for (const g of r.gifts || []) setTimeout(() => sendJ(c.ws, { t: "gift", ...g }), 6000);
    log("join", pid, c.name, c.ip);
    return;
  }
  if (m.t === "_save") return; // saves go through /api/acct/save
  if (m.t === "_save_old") {
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
  if (m.t === "_giftok") {
    const r = await readRec(c.pid);
    if (r?.gifts?.length) {
      r.gifts = r.gifts.filter((g) => g.id !== m.id);
      await writeRec(r);
      log("gift received", c.pid, m.id);
    }
    return;
  }
  if (m.t === "me") (c.lv = m.lv), (c.hero = m.hero), (c.pos = m.p);
  hsend({ o: "msg", id: c.id, m });
}

// ---------------- whole-server backups (players + their backups + settings) ----------------
const FULL = path.join(DATA, "fullbackups");
fs.mkdirSync(FULL, { recursive: true });
const runCmd = (cmd, args, opts = {}) =>
  new Promise((ok, bad) => {
    const ch = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let err = "";
    ch.stderr.on("data", (d) => (err += d));
    ch.on("error", bad);
    ch.on("exit", (code) => (code === 0 ? ok() : bad(new Error(err.trim().slice(0, 300) || cmd + " failed (" + code + ")"))));
  });
const okFull = (f) => /^\d{10,}-[a-z-]+\.tgz$/.test(f) && fs.existsSync(path.join(FULL, f));
const listFull = () =>
  fs.readdirSync(FULL).filter((f) => /\.tgz$/.test(f)).sort().reverse().map((f) => {
    const st = fs.statSync(path.join(FULL, f));
    const m = f.match(/^(\d+)-([a-z-]+)\.tgz$/) || [];
    return { file: f, at: +m[1] || st.mtimeMs, kind: m[2] || "manual", size: st.size };
  });
let lastAutoBackup = 0;
async function makeFull(kind) {
  await Promise.all([...writing.values()]);
  const name = `${Date.now()}-${kind}.tgz`;
  await runCmd("tar", ["czf", path.join(FULL, name), "-C", DATA, "players", "backups", "config.json"]);
  if (kind === "auto") {
    lastAutoBackup = Date.now();
    const autos = listFull().filter((b) => b.kind === "auto");
    for (const b of autos.slice(Math.max(1, +cfg.autoBackupKeep || 10))) await fsp.unlink(path.join(FULL, b.file)).catch(() => {});
  }
  log("server backup made", name);
  if (kind === "auto") ghAuto(name);
  return name;
}
// ---------------- copies of server backups in a PRIVATE GitHub repository ----------------
const GH_FILE = path.join(DATA, "github.json"); // kept apart from config.json, so the token never goes into a backup
let gh = { repo: "", token: "", branch: "main", folder: "realm-backups", auto: true, keep: 30, last: null };
try { Object.assign(gh, JSON.parse(fs.readFileSync(GH_FILE, "utf8"))); } catch (e) {}
const saveGh = () => fs.writeFileSync(GH_FILE, JSON.stringify(gh, null, 2), { mode: 0o600 });
const ghApi = async (p, opts = {}) => {
  const r = await fetch((process.env.VF_GH_API || "https://api.github.com") + p, { ...opts, headers: { Authorization: "Bearer " + gh.token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "vigilfall-realm", ...(opts.headers || {}) } });
  return r;
};
const ghPath = (name) => `/repos/${gh.repo}/contents/${encodeURIComponent(gh.folder)}${name ? "/" + encodeURIComponent(name) : ""}`;
async function ghTest() {
  if (!/^[\w.-]+\/[\w.-]+$/.test(gh.repo)) throw new Error("Repository must look like owner/name, e.g. polemarxos/Vigilfall-backups.");
  if (!gh.token) throw new Error("No GitHub token saved.");
  const r = await ghApi(`/repos/${gh.repo}`);
  if (r.status === 401) throw new Error("GitHub refused the token (wrong or expired).");
  if (r.status === 404) throw new Error("Repository not found, or the token cannot see it.");
  if (!r.ok) throw new Error("GitHub answered " + r.status);
  const j = await r.json();
  if (!j.private) throw new Error("That repository is PUBLIC. Backups hold every player's save and the admin password: use a private repository.");
  if (j.permissions && !j.permissions.push) throw new Error("The token can read but not write this repository (give it Contents: Read and write).");
  gh.branch = gh.branch || j.default_branch || "main";
  return { ok: true, repo: j.full_name, branch: gh.branch };
}
async function ghList() {
  const r = await ghApi(ghPath() + "?ref=" + encodeURIComponent(gh.branch));
  if (r.status === 404) return [];
  if (!r.ok) throw new Error("GitHub list failed: " + r.status);
  const j = await r.json();
  return (Array.isArray(j) ? j : []).filter((f) => f.type === "file" && /\.tgz$/.test(f.name)).map((f) => ({ name: f.name, size: f.size, sha: f.sha })).sort((a, b) => (a.name < b.name ? 1 : -1));
}
async function ghUpload(file) {
  if (!okFull(file)) throw new Error("No such backup.");
  await ghTest();
  const buf = await fsp.readFile(path.join(FULL, file));
  if (buf.length > 90e6) throw new Error("Backup too big for GitHub (over 90 MB).");
  let sha;
  const ex = await ghApi(ghPath(file) + "?ref=" + encodeURIComponent(gh.branch));
  if (ex.ok) sha = (await ex.json()).sha;
  const r = await ghApi(ghPath(file), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "Realm backup " + file, content: buf.toString("base64"), branch: gh.branch, ...(sha ? { sha } : {}) }) });
  if (!r.ok) throw new Error("GitHub upload failed: " + r.status + " " + ((await r.json().catch(() => ({}))).message || ""));
  // keep only the newest N copies on GitHub
  let pruned = 0;
  if (+gh.keep > 0) {
    const all = await ghList();
    for (const f of all.slice(+gh.keep)) {
      const d = await ghApi(ghPath(f.name), { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "Remove old Realm backup " + f.name, sha: f.sha, branch: gh.branch }) });
      d.ok && pruned++;
    }
  }
  gh.last = { at: Date.now(), ok: true, file, msg: "sent" + (pruned ? `, ${pruned} old copy(ies) removed` : "") };
  saveGh();
  log("backup copied to GitHub", file);
  return gh.last;
}
async function ghFetch(name) {
  if (!/^[\w.-]+\.tgz$/.test(name)) throw new Error("Bad file name.");
  await ghTest();
  const r = await ghApi(ghPath(name) + "?ref=" + encodeURIComponent(gh.branch), { headers: { Accept: "application/vnd.github.raw" } });
  if (!r.ok) throw new Error("GitHub download failed: " + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  const dst = `${Date.now()}-github.tgz`;
  await fsp.writeFile(path.join(FULL, dst), buf);
  try { await runCmd("tar", ["tzf", path.join(FULL, dst)]); } catch (e) { await fsp.unlink(path.join(FULL, dst)).catch(() => {}); throw new Error("That GitHub file is not a Realm backup."); }
  log("backup brought back from GitHub", name, "->", dst);
  return dst;
}
const ghAuto = (file) => {
  if (!gh.auto || !gh.repo || !gh.token) return;
  ghUpload(file).catch((e) => {
    gh.last = { at: Date.now(), ok: false, file, msg: e.message };
    saveGh();
    log("GitHub copy failed", e.message);
  });
};
let backupTimer = null, nextAutoBackup = 0;
const scheduleBackups = () => {
  clearInterval(backupTimer);
  const h = +cfg.autoBackupHours || 0;
  nextAutoBackup = 0;
  if (h > 0) {
    const ms = Math.max(1, h) * 3600e3;
    nextAutoBackup = Date.now() + ms;
    backupTimer = setInterval(() => {
      nextAutoBackup = Date.now() + ms;
      makeFull("auto").catch((e) => log("auto backup failed", e.message));
    }, ms);
  }
};
async function restoreFull(file) {
  if (!okFull(file)) throw new Error("No such backup.");
  await makeFull("before-restore");
  const tmp = path.join(DATA, "restore-tmp");
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.mkdir(tmp, { recursive: true });
  await runCmd("tar", ["xzf", path.join(FULL, file), "-C", tmp]);
  if (!fs.existsSync(path.join(tmp, "players"))) {
    await fsp.rm(tmp, { recursive: true, force: true });
    throw new Error("That file is not a Realm backup (no players folder).");
  }
  for (const c of [...clients.values()]) c.authed && kick(c.id, "The Realm is being restored from a backup. Come back in a minute.");
  await Promise.all([...writing.values()]);
  await fsp.rm(PLAYERS, { recursive: true, force: true });
  await fsp.rename(path.join(tmp, "players"), PLAYERS);
  if (fs.existsSync(path.join(tmp, "backups"))) {
    await fsp.rm(BACKUPS, { recursive: true, force: true });
    await fsp.rename(path.join(tmp, "backups"), BACKUPS);
  }
  let pwChanged = false;
  try {
    const old = JSON.parse(await fsp.readFile(path.join(tmp, "config.json"), "utf8"));
    pwChanged = !!old.adminPassword && old.adminPassword !== cfg.adminPassword;
    const keep = { port: cfg.port, bind: cfg.bind, hostToken: cfg.hostToken };
    Object.assign(cfg, old, keep);
    saveCfg();
  } catch (e) {}
  await fsp.rm(tmp, { recursive: true, force: true });
  loadRecs();
  scheduleUpdates();
  scheduleBackups();
  log("restored server backup", file, recs.size + " players");
  restartHost("restored backup");
  return { players: recs.size, passwordChanged: pwChanged };
}
// one-time download links (phones download with the system downloader, which cannot send the password)
const dls = new Map();
const dlToken = (item) => {
  const t = rnd(24);
  dls.set(t, { ...item, exp: Date.now() + 10 * 60e3 });
  for (const [k, v] of dls) v.exp < Date.now() && dls.delete(k);
  return t;
};
// the server program updates itself from GitHub

const SELF_FILES = ["realm.js", "host.js", "package.json", "admin/index.html", "setup.sh", "README.md"];
async function latestServer() {
  const t = String(await srcGet("server/realm.js"));
  return (t.match(/SERVER_VERSION = "([\d.]+)"/) || [])[1] || null;
}
let selfUpdating = false;
async function selfUpdate() {
  if (selfUpdating) throw new Error("Already updating.");
  selfUpdating = true;
  try {
    const got = {};
    for (const f of SELF_FILES) {
      got[f] = await srcGet("server/" + f);
    }
    const code = got["realm.js"].toString("utf8");
    const ver = (code.match(/SERVER_VERSION = "([\d.]+)"/) || [])[1];
    if (!ver) throw new Error("The downloaded server program looks wrong; nothing was changed.");
    const chk = path.join(os.tmpdir(), "vf-realm-check.js");
    await fsp.writeFile(chk, got["realm.js"]);
    await runCmd(process.execPath, ["--check", chk]);
    const pkgChanged = !fs.existsSync(path.join(ROOT, "package.json")) || !got["package.json"].equals(fs.readFileSync(path.join(ROOT, "package.json")));
    for (const f of SELF_FILES) {
      const dst = path.join(ROOT, f);
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.writeFile(dst + ".new", got[f]);
      await fsp.rename(dst + ".new", dst);
    }
    if (pkgChanged) await runCmd("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: ROOT });
    log("server program updated", SERVER_VERSION, "->", ver, "— restarting");
    announce("The Realm restarts for a server update. You will be back in about a minute.", "Realm");
    setTimeout(() => {
      H.wantStop = true;
      try { H.child?.kill("SIGTERM"); } catch (e) {}
      setTimeout(() => process.exit(0), 2000);
    }, 1500);
    return { ok: true, from: SERVER_VERSION, to: ver };
  } finally {
    selfUpdating = false;
  }
}

// ---------------- accounts: name + password, the save follows the player to every device ----------------
const SESS_FILE = path.join(DATA, "sessions.json");
let sessions = {};
try { sessions = JSON.parse(fs.readFileSync(SESS_FILE, "utf8")); } catch (e) {}
let sessT = null;
const saveSessions = () => {
  clearTimeout(sessT);
  sessT = setTimeout(() => {
    const now = Date.now();
    for (const k in sessions) sessions[k].exp < now && delete sessions[k];
    fs.writeFile(SESS_FILE, JSON.stringify(sessions), { mode: 0o600 }, () => {});
  }, 500);
};
const pwHash = (pw, salt = crypto.randomBytes(16).toString("hex")) => salt + ":" + crypto.scryptSync(String(pw), salt, 32).toString("hex");
const pwOk = (pw, stored) => {
  if (!stored || !stored.includes(":")) return false;
  const [salt, h] = stored.split(":");
  const a = Buffer.from(h, "hex"), b = crypto.scryptSync(String(pw), salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const newSession = (pid) => {
  const t = rnd(32);
  sessions[t] = { pid, exp: Date.now() + 180 * 86400e3 };
  saveSessions();
  return t;
};
const okName = (n) => typeof n === "string" && /^[A-Za-z0-9_-]{3,16}$/.test(n);
const PIDCH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newPid = () => { let p; do { p = Array.from(crypto.randomBytes(8), (b) => PIDCH[b % PIDCH.length]).join(""); } while (recs.has(p)); return p; };
const acctFails = new Map();
const acctView = (r) => ({ name: r.name, pid: r.pid, rev: r.rev || 0, profile: r.profile || null, savedAt: r.savedAt || 0, gifts: r.gifts || [], rc: !!r.rcHash });
// recovery code: lets a player set a new password without the admin (shown once, kept only as a hash)
const newRecovery = () => Array.from({ length: 3 }, () => Array.from(crypto.randomBytes(4), (b) => PIDCH[b % PIDCH.length]).join("")).join("-");
const normRc = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const tooMany = (key) => { const f = acctFails.get(key); return f && f.n >= 8 && Date.now() - f.t < 10 * 60e3; };
const failed = (key) => { const f = acctFails.get(key); acctFails.set(key, { n: (f && Date.now() - f.t < 10 * 60e3 ? f.n : 0) + 1, t: Date.now() }); };

// ---- anti-cheat: refuse saves with impossible jumps (the server keeps the last good save; the refused one is kept as a "refused" backup) ----
const MAX_LEVEL = 60;
const num = (v) => (typeof v === "number" && isFinite(v) ? v : NaN);
function cheatCheck(r, prof) {
  if (!cfg.antiCheat) return null;
  const tol = Math.max(1, +cfg.cheatTolerance || 1);
  const old = r.profile || { shards: 0, marks: 0, heroes: {} };
  const sh = num(prof.shards), mk = num(prof.marks);
  if (isNaN(sh) || isNaN(mk) || sh < 0 || mk < 0) return "broken Soul Shards or Ashen Marks";
  if (sh > 5e7 * tol || mk > 5e5 * tol) return "far more Soul Shards or Ashen Marks than the game can give";
  let lvUp = 0;
  for (const [id, h] of Object.entries(prof.heroes || {})) {
    const lv = num(h?.level ?? 1);
    if (isNaN(lv) || lv < 1 || lv > MAX_LEVEL) return "a hero above level " + MAX_LEVEL;
    lvUp = Math.max(lvUp, lv - (old.heroes?.[id]?.level || 1));
  }
  // gains since the last accepted save, plus a rolling one-hour total
  const now = Date.now(), hrs = Math.min(24, Math.max(0, (now - (r.acceptedAt || now)) / 3600e3));
  const allow = r.acAllow || { shards: 0, marks: 0 };
  const dS = Math.max(0, sh - (old.shards || 0) - allow.shards), dM = Math.max(0, mk - (old.marks || 0) - allow.marks);
  const w = r.acWin && now - r.acWin.t < 3600e3 ? r.acWin : { t: now, s: 0, m: 0, l: 0 };
  const lim = { s: (60000 + 100000 * hrs) * tol, m: (600 + 800 * hrs) * tol, l: (8 + 20 * hrs) * tol };
  const hour = { s: 250000 * tol, m: 2500 * tol, l: 30 * tol };
  if (dS > lim.s || w.s + dS > hour.s) return "+" + Math.round(dS).toLocaleString("en") + " Soul Shards too fast";
  if (dM > lim.m || w.m + dM > hour.m) return "+" + Math.round(dM).toLocaleString("en") + " Ashen Marks too fast";
  if (lvUp > lim.l || w.l + Math.max(0, lvUp) > hour.l) return "+" + lvUp + " hero levels too fast";
  r._acNext = { win: { t: w.t, s: w.s + dS, m: w.m + dM, l: w.l + Math.max(0, lvUp) } };
  return null;
}
async function acctApi(req, res, url) {
  const p = url.pathname.replace(/^\/api\/acct\/?/, "");
  const b = req.method === "POST" ? await body(req).catch(() => ({})) : {};
  const ip = ipOf(req);
  if (p === "register" || p === "login" || p === "recover") {
    const name = String(b.name || "").trim(), pw = String(b.password || "");
    const key = ip + "|" + name.toLowerCase();
    if (tooMany(key)) return json(res, 429, { error: "Too many tries. Wait 10 minutes." });
    if (!okName(name)) return json(res, 400, { error: "Name: 3 to 16 letters, numbers, - or _." });
    if (pw.length < 6) return json(res, 400, { error: "Password: at least 6 characters." });
    const low = name.toLowerCase();
    if (p === "register") {
      if (byName.has(low)) return json(res, 409, { error: "That name is taken." });
      if (cfg.maintenance) return json(res, 503, { error: cfg.maintenanceMsg || "Closed for maintenance." });
      const pid = newPid(), now = Date.now();
      const recovery = newRecovery();
      const r = { pid, acct: low, name, pwHash: pwHash(pw), rcHash: pwHash(normRc(recovery)), created: now, lastSeen: now, rev: 0, adminRev: 0, ip };
      byName.set(low, pid);
      await writeRec(r);
      log("account created", name, pid, ip);
      return json(res, 200, { ok: true, token: newSession(pid), recovery, ...acctView(r) });
    }
    const pid = byName.get(low), r = pid && (await readRec(pid));
    if (p === "recover") {
      if (!r || !r.rcHash || !pwOk(normRc(b.code), r.rcHash)) {
        failed(key);
        return json(res, 401, { error: r && !r.rcHash ? "This account has no recovery code. Ask the Realm admin to reset the password." : "Wrong name or recovery code." });
      }
      acctFails.delete(key);
      if (r.banned) return json(res, 403, { error: "This account is banned" + (r.banReason ? ": " + r.banReason : ".") });
      const recovery = newRecovery();
      r.pwHash = pwHash(pw);
      r.rcHash = pwHash(normRc(recovery));
      r.lastSeen = Date.now();
      for (const k in sessions) sessions[k].pid === r.pid && delete sessions[k];
      saveSessions();
      await writeRec(r);
      log("password reset with recovery code", r.name, ip);
      return json(res, 200, { ok: true, token: newSession(pid), recovery, ...acctView(r) });
    }
    if (!r || !pwOk(pw, r.pwHash)) {
      failed(key);
      return json(res, 401, { error: "Wrong name or password." });
    }
    acctFails.delete(key);
    if (r.banned) return json(res, 403, { error: "This account is banned" + (r.banReason ? ": " + r.banReason : ".") });
    r.lastSeen = Date.now();
    await writeRec(r);
    log("sign in", r.name, ip);
    return json(res, 200, { ok: true, token: newSession(pid), ...acctView(r) });
  }
  const sess = sessions[String(b.token || url.searchParams.get("token") || "")];
  if (!sess || sess.exp < Date.now()) return json(res, 401, { error: "Signed out: please sign in again.", signedOut: true });
  const r = await readRec(sess.pid);
  if (!r) return json(res, 401, { error: "This account no longer exists.", signedOut: true });
  if (r.banned) return json(res, 403, { error: "This account is banned" + (r.banReason ? ": " + r.banReason : "."), signedOut: true });
  if (p === "me") return json(res, 200, acctView(r));
  // light "am I online" check the game makes every few seconds
  if (p === "ping") return json(res, 200, { ok: true, rev: r.rev || 0, rc: !!r.rcHash });
  if (p === "recovery") {
    const k = "rc|" + r.pid;
    if (tooMany(k)) return json(res, 429, { error: "Too many tries. Wait 10 minutes." });
    if (!pwOk(String(b.password || ""), r.pwHash)) { failed(k); return json(res, 401, { error: "The password is wrong." }); }
    const recovery = newRecovery();
    r.rcHash = pwHash(normRc(recovery));
    await writeRec(r);
    log("new recovery code", r.name);
    return json(res, 200, { ok: true, recovery });
  }
  if (p === "logout") { delete sessions[String(b.token)]; saveSessions(); return json(res, 200, { ok: true }); }
  if (p === "password") {
    const k = "rc|" + r.pid;
    if (tooMany(k)) return json(res, 429, { error: "Too many tries. Wait 10 minutes." });
    if (!pwOk(String(b.old || ""), r.pwHash)) { failed(k); return json(res, 401, { error: "The current password is wrong." }); }
    if (String(b.password || "").length < 6) return json(res, 400, { error: "Password: at least 6 characters." });
    r.pwHash = pwHash(b.password);
    for (const k in sessions) sessions[k].pid === r.pid && k !== b.token && delete sessions[k];
    saveSessions();
    await writeRec(r);
    return json(res, 200, { ok: true });
  }
  if (p === "save") {
    // gifts the game has already added
    if (Array.isArray(b.gotGifts) && r.gifts?.length) r.gifts = r.gifts.filter((g) => !b.gotGifts.includes(g.id));
    const prof = b.profile;
    const base = +b.baseRev || 0, rev = r.rev || 0;
    const takeServer = () => json(res, 200, { take: true, ...acctView(r) });
    if (!prof || typeof prof !== "object" || !prof.heroes || !prof.campaign) {
      await writeRec(r);
      return r.profile && base < rev ? takeServer() : json(res, 200, { ok: true, rev, gifts: r.gifts || [] });
    }
    if (base !== rev && r.profile) {
      // the save changed elsewhere since this device last synced
      if (r.adminEdit || !b.dirty || (+prof.savedAt || 0) <= (+r.savedAt || 0)) {
        if (b.dirty) await backup({ pid: r.pid, profile: prof }, "other-device");
        await writeRec(r);
        return takeServer();
      }
      await backup(r, "other-device");
    }
    const why = cheatCheck(r, prof);
    if (why) {
      await backup({ pid: r.pid, profile: prof }, "refused");
      r.flags = [...(r.flags || []), { at: Date.now(), why, ip }].slice(-50);
      await writeRec(r);
      log("anti-cheat refused a save", r.name, r.pid, why);
      return json(res, 200, { take: true, refused: why, ...acctView(r) });
    }
    if (r._acNext) (r.acWin = r._acNext.win), delete r._acNext;
    r.acAllow = { shards: 0, marks: 0 };
    r.acceptedAt = Date.now();
    const hourly = !r.lastBackup || Date.now() - r.lastBackup > 3600e3;
    if (hourly && r.profile) (await backup(r, "auto"), (r.lastBackup = Date.now()));
    prof.name = r.name;
    prof.pid = r.pid;
    delete prof.ckey;
    r.profile = prof;
    r.rev = rev + 1;
    r.adminEdit = false;
    r.savedAt = +prof.savedAt || Date.now();
    r.lastSeen = Date.now();
    r.ver = String(b.ver || r.ver || "");
    await writeRec(r);
    const c = clientOfPid(r.pid);
    c && (c.lv = summaryOf(prof).lv);
    return json(res, 200, { ok: true, rev: r.rev, gifts: r.gifts || [] });
  }
  return json(res, 404, { error: "unknown call" });
}
// first start with accounts: the old device-linked saves are retired (a server backup keeps them)
async function migrateToAccounts() {
  const mark = path.join(DATA, "accounts.on");
  if (fs.existsSync(mark)) return;
  const old = fs.readdirSync(PLAYERS).filter((f) => f.endsWith(".json"));
  if (old.length) {
    try { await makeFull("before-accounts"); } catch (e) { log("backup before accounts failed", e.message); }
    const keep = path.join(DATA, "players-before-accounts-" + Date.now());
    await fsp.rename(PLAYERS, keep);
    await fsp.mkdir(PLAYERS, { recursive: true });
    log("accounts switched on: " + old.length + " old saves moved to " + path.basename(keep));
  }
  fs.writeFileSync(mark, String(Date.now()));
  loadRecs();
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
      name: cfg.name, motd: cfg.motd, maxPlayers: cfg.maxPlayers, autoUpdate: cfg.autoUpdate, updateMinutes: cfg.updateMinutes, serverVersion: SERVER_VERSION, maintenance: cfg.maintenance, maintenanceMsg: cfg.maintenanceMsg, autoBackupHours: cfg.autoBackupHours, autoBackupKeep: cfg.autoBackupKeep, antiCheat: cfg.antiCheat, cheatTolerance: cfg.cheatTolerance, lastAutoBackup, lastCheck, nextCheck, gameUrl: cfg.gameUrl,
      gameVersion: gameVer, hostVersion: H.ver, hostUp: !!H.child, hostReady: H.ready, hostSince: H.startedAt, restarts: H.restarts,
      world: H.stat, uptime: Math.round(process.uptime()), load: os.loadavg(), cpus: os.cpus().length,
      mem: { total: os.totalmem(), free: os.freemem(), server: mem.rss }, players: recs.size, online: onlineList(),
    });
  }
  if (p[0] === "players" && !p[1] && M === "GET") {
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const list = [...recs.values()]
      .filter((r) => !q || r.pid.toLowerCase().includes(q) || String(r.name || "").toLowerCase().includes(q))
      .map((r) => ({ pid: r.pid, name: r.name, lastSeen: r.lastSeen, created: r.created, banned: !!r.banned, online: online.has(r.pid), ...r.sum, hero: r.hero, ver: r.ver, flags: (r.flags || []).length }))
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
      const { keyHash, pwHash, rcHash, ...rest } = r;
      return json(res, 200, { ...rest, rc: !!rcHash, locked: !!keyHash, online: online.has(pid) });
    }
    if (!act && M === "PUT") {
      const b = await body(req);
      const prof = b.profile;
      if (!prof || typeof prof !== "object" || !prof.heroes || !prof.campaign) return json(res, 400, { error: "That is not a Vigilfall save (heroes/campaign missing)." });
      await backup(r, "before-edit");
      r.adminRev = (r.adminRev || 0) + 1;
      r.rev = (r.rev || 0) + 1;
      r.adminEdit = true;
      prof.adminRev = r.adminRev;
      prof.name = r.name;
      prof.pid = r.pid;
      delete prof.ckey;
      r.profile = prof;
      r.editedAt = Date.now();
      await writeRec(r);
      const c = clientOfPid(pid);
      c && sendJ(c.ws, { t: "cloud", p: prof, rev: r.rev });
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
    if (act === "password" && M === "POST") {
      const b = await body(req).catch(() => ({}));
      const pw = String(b.password || "") || rnd(10);
      if (pw.length < 6) return json(res, 400, { error: "At least 6 characters." });
      r.pwHash = pwHash(pw);
      for (const k in sessions) sessions[k].pid === pid && delete sessions[k];
      saveSessions();
      await writeRec(r);
      const c = clientOfPid(pid);
      c && kick(c.id, "Your password was changed. Sign in again.");
      log("password reset by admin", pid);
      return json(res, 200, { ok: true, password: pw });
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
      r.rev = (r.rev || 0) + 1;
      r.adminEdit = true;
      prof.adminRev = r.adminRev;
      r.profile = prof;
      await writeRec(r);
      const c = clientOfPid(pid);
      c && sendJ(c.ws, { t: "cloud", p: prof, rev: r.rev });
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
  if (p[0] === "players" && p[1] && okPid(p[1]) && p[2] === "backup" && M === "POST") {
    const r = await readRec(p[1]);
    if (!r?.profile) return json(res, 404, { error: "No save to back up yet." });
    await backup(r, "manual");
    return json(res, 200, { ok: true });
  }
  if (p[0] === "fullbackups") {
    if (!p[1] && M === "GET") return json(res, 200, { backups: listFull(), autoBackupHours: cfg.autoBackupHours, autoBackupKeep: cfg.autoBackupKeep, antiCheat: cfg.antiCheat, cheatTolerance: cfg.cheatTolerance, lastAutoBackup, nextAutoBackup });
    if (!p[1] && M === "POST") return json(res, 200, { ok: true, file: await makeFull("manual") });
    if (p[1] === "upload" && M === "POST") {
      const name = `${Date.now()}-uploaded.tgz`, dst = path.join(FULL, name);
      await new Promise((ok, bad) => {
        let n = 0;
        const out = fs.createWriteStream(dst);
        req.on("data", (d) => { n += d.length; if (n > 600e6) { bad(new Error("File too big.")); req.destroy(); } });
        req.pipe(out);
        out.on("finish", ok);
        out.on("error", bad);
        req.on("error", bad);
      });
      try {
        await runCmd("tar", ["tzf", dst]);
      } catch (e) {
        await fsp.unlink(dst).catch(() => {});
        return json(res, 400, { error: "That file is not a Realm backup (.tgz)." });
      }
      log("server backup uploaded", name);
      return json(res, 200, { ok: true, file: name });
    }
    const f = path.basename(p[1] || "");
    if (!okFull(f)) return json(res, 404, { error: "No such backup." });
    if (!p[2] && M === "DELETE") {
      await fsp.unlink(path.join(FULL, f));
      log("server backup deleted", f);
      return json(res, 200, { ok: true });
    }
    if (p[2] === "restore" && M === "POST") return json(res, 200, { ok: true, ...(await restoreFull(f)) });
    if (p[2] === "github" && M === "POST") return json(res, 200, await ghUpload(f));
    if (p[2] === "link" && M === "POST") return json(res, 200, { url: "/dl/" + dlToken({ file: path.join(FULL, f), name: "vigilfall-realm-" + f, type: "application/gzip" }) });
  }
  if (p[0] === "github") {
    if (!p[1] && M === "GET") return json(res, 200, { repo: gh.repo, branch: gh.branch, folder: gh.folder, auto: gh.auto, keep: gh.keep, hasToken: !!gh.token, last: gh.last });
    if (!p[1] && M === "POST") {
      const b = await body(req);
      if (typeof b.repo === "string") gh.repo = b.repo.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
      if (typeof b.token === "string" && b.token.trim()) gh.token = b.token.trim();
      if (b.removeToken) gh.token = "";
      if (typeof b.branch === "string" && b.branch.trim()) gh.branch = b.branch.trim();
      if (typeof b.auto === "boolean") gh.auto = b.auto;
      if (b.keep !== undefined) gh.keep = Math.max(0, Math.min(500, Math.round(+b.keep) || 0));
      saveGh();
      log("GitHub backup settings changed", gh.repo);
      if (!gh.repo || !gh.token) return json(res, 200, { ok: true, test: null });
      try { return json(res, 200, { ok: true, test: await ghTest() }); } catch (e) { return json(res, 200, { ok: true, test: { ok: false, error: e.message } }); }
    }
    if (p[1] === "list" && M === "GET") return json(res, 200, { files: await ghList() });
    if (p[1] === "fetch" && M === "POST") { const b = await body(req); return json(res, 200, { ok: true, file: await ghFetch(String(b.name || "")) }); }
  }
  if (p[0] === "source") {
    if (!p[1] && M === "GET") return json(res, 200, { repo: src.repo, branch: src.branch, hasToken: !!src.token, last: src.last, gameVersion: gameVer });
    if (!p[1] && M === "POST") {
      const b = await body(req);
      if (typeof b.repo === "string" && b.repo.trim()) src.repo = b.repo.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
      if (typeof b.branch === "string" && b.branch.trim()) src.branch = b.branch.trim();
      if (typeof b.token === "string" && b.token.trim()) src.token = b.token.trim();
      if (b.removeToken) src.token = "";
      saveSrc();
      log("game source changed", src.repo, src.token ? "(with token)" : "(public)");
      try { const v = String(await srcGet("version.txt")).trim(); return json(res, 200, { ok: true, test: { ok: true, ver: v } }); } catch (e) { return json(res, 200, { ok: true, test: { ok: false, error: e.message } }); }
    }
  }
  if (p[0] === "savelink" && M === "POST") {
    const b = await body(req);
    if (!okPid(String(b.pid || ""))) return json(res, 400, { error: "bad id" });
    let data;
    if (b.backup) {
      const bf = path.basename(String(b.backup));
      try { data = await fsp.readFile(path.join(BACKUPS, b.pid, bf), "utf8"); } catch (e) { return json(res, 404, { error: "No such backup." }); }
    } else {
      const r = await readRec(b.pid);
      if (!r?.profile) return json(res, 404, { error: "No save yet." });
      data = JSON.stringify(r.profile, null, 1);
    }
    return json(res, 200, { url: "/dl/" + dlToken({ data, name: `vigilfall-save-${b.pid}${b.backup ? "-" + String(b.backup).replace(/\.json$/, "") : ""}.json`, type: "application/json" }) });
  }
  if (p[0] === "gift" && M === "POST") {
    const b = await body(req);
    const shards = Math.max(0, Math.min(1e7, Math.round(+b.shards || 0))), marks = Math.max(0, Math.min(1e7, Math.round(+b.marks || 0)));
    if (!shards && !marks) return json(res, 400, { error: "Give some Soul Shards or Ashen Marks." });
    const pids = b.all ? [...recs.keys()] : [String(b.pid || "")].filter(okPid);
    if (!pids.length) return json(res, 400, { error: "No player chosen." });
    let live = 0;
    for (const pid of pids) {
      const r = await readRec(pid);
      if (!r) continue;
      const g = { id: rnd(10), shards, marks, note: String(b.note || "").slice(0, 160), at: Date.now() };
      r.gifts = [...(r.gifts || []), g];
      r.acAllow = { shards: (r.acAllow?.shards || 0) + shards, marks: (r.acAllow?.marks || 0) + marks };
      await writeRec(r);
      const c = clientOfPid(pid);
      if (c) (sendJ(c.ws, { t: "gift", ...g }), live++);
    }
    log("gift", b.all ? "to all" : pids[0], shards + " shards", marks + " marks");
    return json(res, 200, { ok: true, players: pids.length, live });
  }
  if (p[0] === "server" && M === "GET") {
    let latest = null;
    try { latest = await latestServer(); } catch (e) {}
    return json(res, 200, { version: SERVER_VERSION, latest });
  }
  if (p[0] === "server" && p[1] === "update" && M === "POST") return json(res, 200, await selfUpdate());
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
    if (b.autoBackupHours !== undefined) cfg.autoBackupHours = Math.max(0, Math.min(168, Math.round(+b.autoBackupHours) || 0));
    if (b.autoBackupKeep !== undefined) cfg.autoBackupKeep = Math.max(1, Math.min(100, Math.round(+b.autoBackupKeep) || 10));
    if (typeof b.antiCheat === "boolean") cfg.antiCheat = b.antiCheat;
    if (b.cheatTolerance !== undefined) cfg.cheatTolerance = Math.max(1, Math.min(20, Math.round(+b.cheatTolerance) || 1));
    if (typeof b.maintenanceMsg === "string") cfg.maintenanceMsg = b.maintenanceMsg.slice(0, 200);
    if (typeof b.maintenance === "boolean" && b.maintenance !== cfg.maintenance) {
      cfg.maintenance = b.maintenance;
      log("maintenance", cfg.maintenance ? "ON" : "off");
      if (cfg.maintenance) for (const c of [...clients.values()]) c.authed && kick(c.id, cfg.maintenanceMsg || "The Realm is closed for maintenance.");
    }
    if (b.updateMinutes !== undefined) cfg.updateMinutes = Math.max(1, Math.min(1440, Math.round(+b.updateMinutes) || 10));
    if (typeof b.newPassword === "string") {
      if (b.newPassword.length < 8) return json(res, 400, { error: "Password must be at least 8 characters." });
      cfg.adminPassword = b.newPassword;
    }
    saveCfg();
    scheduleUpdates();
    scheduleBackups();
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
  if (p[0] === "update" && M === "POST") return (lastCheck = Date.now()), json(res, 200, await updateAndRestart(true));
  if (p[0] === "log" && M === "GET") return json(res, 200, { lines: LOG.slice(-300) });
  return json(res, 404, { error: "unknown call" });
}

const ADMIN_HTML = path.join(ROOT, "admin", "index.html");
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "OPTIONS") return (res.writeHead(204, CORS), res.end());
    if (url.pathname === "/health") return json(res, 200, { ok: true, name: cfg.name, online: [...clients.values()].filter((c) => c.authed).length, max: cfg.maxPlayers, ver: H.ver || gameVer, ready: H.ready, maintenance: cfg.maintenance, server: SERVER_VERSION });
    if (url.pathname.startsWith("/api/acct/")) return await acctApi(req, res, url);
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (url.pathname.startsWith("/dl/")) {
      const it = dls.get(url.pathname.slice(4));
      if (!it || it.exp < Date.now()) return json(res, 404, { error: "This download link has expired. Make a new one in the admin app." });
      res.writeHead(200, { "Content-Type": it.type, "Content-Disposition": `attachment; filename="${it.name}"`, "Cache-Control": "no-store", ...CORS });
      return it.data ? res.end(it.data) : fs.createReadStream(it.file).pipe(res);
    }
    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return fs.createReadStream(ADMIN_HTML).pipe(res);
    }
    // the game and both Android apps, handed out by this server
    const pub = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (req.method === "GET" && PUBLIC_FILES.includes(pub) && fs.existsSync(path.join(GAME, pub))) {
      const type = { html: "text/html; charset=utf-8", txt: "text/plain; charset=utf-8", webmanifest: "application/manifest+json", js: "text/javascript; charset=utf-8", png: "image/png", apk: "application/vnd.android.package-archive", json: "application/json" }[pub.split(".").pop()] || "application/octet-stream";
      if (pub === "VigilfallAdmin.json" && adminAppInfo) return json(res, 200, { ...adminAppInfo, apk: "/VigilfallAdmin.apk" });
      const st = fs.statSync(path.join(GAME, pub));
      res.writeHead(200, { "Content-Type": type, "Content-Length": st.size, "Cache-Control": /\.(png)$/.test(pub) ? "public, max-age=86400" : "no-cache", ...(pub.endsWith(".apk") ? { "Content-Disposition": `attachment; filename="${pub}"` } : {}), ...CORS });
      return fs.createReadStream(path.join(GAME, pub)).pipe(res);
    }
    if (url.pathname === "/realm.json") return json(res, 200, { url: String(req.headers.host || "").replace(/:\d+$/, "") });
    if (url.pathname === "/info") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html><meta name=viewport content="width=device-width"><body style="background:#111;color:#e8dcc0;font-family:sans-serif;text-align:center;padding-top:20vh"><h1>${cfg.name}</h1><p>This is a Vigilfall Realm server. <a style="color:#ffd070" href="/">Play here</a> and press <b>Enter the Realm</b> · <a style="color:#ffd070" href="/Vigilfall.apk">Android app</a></p><p><a style="color:#9ad0ff" href="/admin">Admin</a></p>`);
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
    // one message at a time per player, so a save and a gift receipt never overwrite each other
    if (m && typeof m === "object") c.q = (c.q || Promise.resolve()).then(() => onClientMsg(c, m)).catch((e) => log("client msg error", e.message));
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
      if (f.ok && !H.ready) log("world ready after " + Math.round((Date.now() - H.startedAt) / 1000) + " s", f.ver);
      H.ready = !!f.ok;
      if (H.ready) H.statAt = Date.now();
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
  migrateToAccounts().catch((e) => log("accounts migration failed", e.message));
  if (process.env.VF_NOHOST !== "1") startHost();
  cfg.autoUpdate && setTimeout(() => ((lastCheck = Date.now()), updateAndRestart(false)), 20e3);
  scheduleUpdates();
  scheduleBackups();
});
const bye = () => {
  H.wantStop = true;
  try { H.child?.kill("SIGTERM"); } catch (e) {}
  setTimeout(() => process.exit(0), 1500);
};
process.on("SIGTERM", bye);
process.on("SIGINT", bye);
