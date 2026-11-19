package com.polemarxos.vigilfall;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Map;

/* Vigilfall for Android 1.1.
   The game ships inside the app (assets/index.html) and is served from there under the website's own address, so it
   opens in seconds, works offline, and keeps the same saves as before. On every start the app asks the website for
   version.txt (a few bytes); when a newer game exists it downloads it in the background and uses it from then on. */
public class MainActivity extends Activity {
    static final String HOST = "polemarxos.github.io";
    static final String BASE = "https://" + HOST + "/Vigilfall/";
    // new versions come from the Realm server (the GitHub repository is private); the page keeps its old address so saves stay
    static final String UPD = "https://vigilfall.duckdns.org/";
    WebView web;
    PermissionRequest pending;
    long lastBack;
    volatile boolean awake = true;

    File localGame() { return new File(getFilesDir(), "index.html"); }
    File localVer() { return new File(getFilesDir(), "version.txt"); }

    String readAll(InputStream in) throws Exception {
        BufferedReader r = new BufferedReader(new InputStreamReader(in, "UTF-8"));
        StringBuilder b = new StringBuilder(); String l;
        while ((l = r.readLine()) != null) b.append(l);
        r.close();
        return b.toString().trim();
    }

    String currentVersion() {
        try { if (localVer().exists() && localGame().exists()) return readAll(new FileInputStream(localVer())); } catch (Exception e) {}
        try { return readAll(getAssets().open("version.txt")); } catch (Exception e) { return "0"; }
    }

    static int[] parse(String v) {
        String[] p = v.replaceAll("[^0-9.]", "").split("\\.");
        int[] o = new int[3];
        for (int i = 0; i < 3 && i < p.length; i++) try { o[i] = Integer.parseInt(p[i]); } catch (Exception e) {}
        return o;
    }

    static boolean newer(String a, String b) {
        int[] x = parse(a), y = parse(b);
        for (int i = 0; i < 3; i++) if (x[i] != y[i]) return x[i] > y[i];
        return false;
    }

    InputStream gameStream() throws Exception {
        if (localGame().exists() && localVer().exists() && !newer(readAll(getAssets().open("version.txt")), readAll(new FileInputStream(localVer()))))
            return new FileInputStream(localGame());
        return getAssets().open("index.html");
    }

    volatile boolean checking = false;
    void checkUpdate() {
        if (checking) return;
        checking = true;
        new Thread(new Runnable() { public void run() {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(UPD + "version.txt?t=" + System.currentTimeMillis()).openConnection();
                c.setConnectTimeout(6000); c.setReadTimeout(6000); c.setUseCaches(false);
                if (c.getResponseCode() != 200) return;
                String remote = readAll(c.getInputStream());
                if (!newer(remote, currentVersion())) return;
                HttpURLConnection d = (HttpURLConnection) new URL(UPD + "index.html?v=" + remote).openConnection();
                d.setConnectTimeout(10000); d.setReadTimeout(60000); d.setUseCaches(false);
                if (d.getResponseCode() != 200) return;
                File tmp = new File(getFilesDir(), "index.tmp");
                InputStream in = d.getInputStream(); OutputStream out = new FileOutputStream(tmp);
                byte[] buf = new byte[65536]; int n; long total = 0;
                while ((n = in.read(buf)) > 0) { out.write(buf, 0, n); total += n; }
                out.close(); in.close();
                if (total < 1000000) { tmp.delete(); return; }
                tmp.renameTo(localGame());
                FileOutputStream vo = new FileOutputStream(localVer()); vo.write(remote.getBytes("UTF-8")); vo.close();
                runOnUiThread(new Runnable() { public void run() {
                    web.evaluateJavascript("(function(){var g=window.__app&&__app.game;if(!g||!g.running){location.reload();return 'reload'}g.toast&&g.toast('A new version of Vigilfall is ready — it starts next time you open the app','#ffd070');return 'later'})()", null);
                }});
            } catch (Exception e) {} finally { checking = false; }
        }}).start();
    }

    // small bridge for the game: keep the screen awake only while playing
    public class Bridge {
        @JavascriptInterface public void keepAwake(final boolean on) {
            if (on == awake) return;
            awake = on;
            runOnUiThread(new Runnable() { public void run() {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }});
        }
        @JavascriptInterface public String version() { return currentVersion(); }
        @JavascriptInterface public String appVersion() { return "1.1"; }
    }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 28) getWindow().getAttributes().layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setLongClickable(false);
        web.setOnLongClickListener(new View.OnLongClickListener() { public boolean onLongClick(View v) { return true; } });
        web.setHapticFeedbackEnabled(false);
        if (Build.VERSION.SDK_INT >= 26) web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setUserAgentString(s.getUserAgentString() + " VigilfallApp/1.1");
        web.addJavascriptInterface(new Bridge(), "VigilfallApp");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                String path = u.getPath() == null ? "" : u.getPath();
                if (HOST.equals(u.getHost()) && "GET".equals(r.getMethod()) && (path.equals("/Vigilfall/") || path.equals("/Vigilfall") || path.equals("/Vigilfall/index.html"))) {
                    try {
                        Map<String, String> h = new HashMap<String, String>();
                        h.put("Cache-Control", "no-store");
                        h.put("Access-Control-Allow-Origin", "*");
                        return new WebResourceResponse("text/html", "utf-8", 200, "OK", h, gameStream());
                    } catch (Exception e) { return null; }
                }
                return null;
            }
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (HOST.equals(u.getHost()) && !u.getPath().endsWith(".apk")) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) {}
                return true;
            }
            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                // the game itself is local, so only show this if even the local copy could not load
                if (r.isForMainFrame() && !HOST.equals(r.getUrl().getHost()))
                    v.loadData("<html><body style='background:#0b0806;color:#e8d4a0;font:18px Georgia,serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center'><div>Vigilfall could not start.<br><br><a style='color:#ffd070' href='" + BASE + "'>Try again</a></div></body></html>", "text/html", "utf-8");
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest req) {
                runOnUiThread(new Runnable() { public void run() {
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) req.grant(req.getResources());
                    else { pending = req; requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 7); }
                }});
            }
        });
        setContentView(web);
        immersive();
        if (b != null) web.restoreState(b); else web.loadUrl(BASE);
    }

    void immersive() {
        web.setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    @Override
    public void onWindowFocusChanged(boolean f) { super.onWindowFocusChanged(f); if (f) immersive(); }

    @Override
    public void onRequestPermissionsResult(int code, String[] p, int[] r) {
        if (pending != null) {
            if (r.length > 0 && r[0] == PackageManager.PERMISSION_GRANTED) pending.grant(pending.getResources()); else pending.deny();
            pending = null;
        }
    }

    // Back = Esc in the game (pause menu / close a window); twice quickly leaves the app
    @Override
    public void onBackPressed() {
        long now = System.currentTimeMillis();
        if (now - lastBack < 1200) { super.onBackPressed(); return; }
        lastBack = now;
        web.evaluateJavascript("(function(){var o={key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true};document.dispatchEvent(new KeyboardEvent('keydown',o));setTimeout(function(){document.dispatchEvent(new KeyboardEvent('keyup',o));},60);})()", null);
        Toast.makeText(this, "Press back again to leave", Toast.LENGTH_SHORT).show();
    }

    @Override protected void onPause() { super.onPause(); web.onPause(); }
    @Override protected void onResume() { super.onResume(); web.onResume(); immersive(); checkUpdate(); }
    @Override protected void onSaveInstanceState(Bundle o) { super.onSaveInstanceState(o); web.saveState(o); }
}
