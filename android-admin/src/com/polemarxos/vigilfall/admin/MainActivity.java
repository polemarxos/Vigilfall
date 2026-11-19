package com.polemarxos.vigilfall.admin;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.webkit.ValueCallback;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.InputStream;

public class MainActivity extends Activity {
    static final String HOST = "vigilfall-admin.app";
    WebView web;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(20, 17, 13));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " VigilfallAdmin/1.0");
        web.setOverScrollMode(WebView.OVER_SCROLL_NEVER);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                // the admin page is served from the app itself on a fixed https origin (keeps the saved login)
                if (HOST.equals(r.getUrl().getHost())) {
                    try {
                        InputStream in = getAssets().open("admin.html");
                        return new WebResourceResponse("text/html", "utf-8", in);
                    } catch (Exception e) {
                        return null;
                    }
                }
                return null;
            }
        });
        setContentView(web);
        if (b != null) web.restoreState(b);
        else web.loadUrl("https://" + HOST + "/");
    }

    @Override
    protected void onSaveInstanceState(Bundle o) {
        super.onSaveInstanceState(o);
        web.saveState(o);
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("(window.VFA_back && window.VFA_back()) ? 'y' : 'n'", new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String v) {
                if (v == null || !v.contains("y")) MainActivity.super.onBackPressed();
            }
        });
    }
}
