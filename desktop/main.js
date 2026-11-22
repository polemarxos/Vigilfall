// Vigilfall for Windows: a window around the online game (always the newest version, nothing to update here).
const { app, BrowserWindow, shell, session, Menu, globalShortcut } = require("electron");
const path = require("path");

const GAME = "https://polemarxos.github.io/Vigilfall/";
const VER = "1.0.0";

if (!app.requestSingleInstanceLock()) app.quit();
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

let win = null;

const offlinePage = (why) =>
  "data:text/html;charset=utf-8," +
  encodeURIComponent(`<!doctype html><html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#06080c;color:#e8e0d0;font-family:Georgia,serif;text-align:center">
  <div><div style="font-size:46px">🕯</div><h1 style="letter-spacing:.2em;color:#c9a96a">VIGILFALL</h1>
  <p>Could not reach the game. Check your internet connection.</p><p style="opacity:.6;font-size:13px">${String(why).replace(/[<>]/g, "")}</p>
  <button onclick="location.href='${GAME}'" style="margin-top:14px;padding:12px 34px;font:16px Georgia,serif;letter-spacing:.15em;color:#f0e0c0;background:linear-gradient(#5a4428,#2a1e10);border:1px solid #c9a96a;border-radius:4px;cursor:pointer">TRY AGAIN</button></div>
  <script>addEventListener('online',()=>location.href='${GAME}')</script></body></html>`);

function create() {
  win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 960,
    minHeight: 540,
    show: false,
    backgroundColor: "#06080c",
    title: "Vigilfall",
    icon: path.join(__dirname, "icon.png"),
    autoHideMenuBar: true,
    webPreferences: { backgroundThrottling: false, spellcheck: false, contextIsolation: true, sandbox: true },
  });
  Menu.setApplicationMenu(null);
  win.webContents.setUserAgent(win.webContents.getUserAgent() + " VigilfallDesktop/" + VER);
  win.once("ready-to-show", () => (win.maximize(), win.show()));

  // links to other sites open in the normal browser; the game stays in this window
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith(GAME) || url.startsWith("data:")) return;
    e.preventDefault();
    /^https?:/i.test(url) && shell.openExternal(url);
  });
  win.webContents.on("did-fail-load", (e, code, desc, url, main) => {
    if (main && code !== -3) win.loadURL(offlinePage(desc + " (" + code + ")"));
  });

  // keys: F11 full screen, Ctrl+R / F5 reload, Ctrl+Shift+I developer tools
  win.webContents.on("before-input-event", (e, i) => {
    if (i.type !== "keyDown") return;
    if (i.key === "F11") (win.setFullScreen(!win.isFullScreen()), e.preventDefault());
    else if (i.key === "F5" || (i.control && i.key.toLowerCase() === "r")) (win.webContents.reload(), e.preventDefault());
    else if (i.control && i.shift && i.key.toLowerCase() === "i") win.webContents.toggleDevTools();
  });
  win.loadURL(GAME);
}

app.on("second-instance", () => {
  if (!win) return;
  win.isMinimized() && win.restore();
  win.focus();
});

app.whenReady().then(() => {
  // microphone (voice chat), pointer lock, full screen, clipboard and notifications; nothing else
  const ok = new Set(["media", "pointerLock", "fullscreen", "clipboard-read", "clipboard-sanitized-write", "notifications", "keyboardLock"]);
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(ok.has(perm)));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => ok.has(perm));
  create();
});
app.on("window-all-closed", () => app.quit());
