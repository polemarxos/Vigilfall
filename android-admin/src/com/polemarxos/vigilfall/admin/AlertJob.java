package com.polemarxos.vigilfall.admin;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONArray;
import org.json.JSONObject;

// Phone alerts: about every 15 minutes (also with the app closed) the phone asks the Realm server how it is
// and what happened since the last check, and shows a notification for what the admin ticked.
public class AlertJob extends JobService {
    static final int JOB_ID = 4711;
    static final String CH = "realm_alerts";

    @Override public boolean onStartJob(final JobParameters p) {
        new Thread(new Runnable() { public void run() { try { check(AlertJob.this); } catch (Throwable t) {} jobFinished(p, false); } }).start();
        return true;
    }
    @Override public boolean onStopJob(JobParameters p) { return true; }

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences("alerts", MODE_PRIVATE); }

    static void schedule(Context c) {
        JobScheduler js = (JobScheduler) c.getSystemService(JOB_SCHEDULER_SERVICE);
        if (!prefs(c).getBoolean("on", false)) { js.cancel(JOB_ID); return; }
        JobInfo.Builder b = new JobInfo.Builder(JOB_ID, new ComponentName(c, AlertJob.class))
            .setPeriodic(15 * 60 * 1000L)
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPersisted(true);
        js.schedule(b.build());
    }

    static void channel(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) c.getSystemService(NOTIFICATION_SERVICE);
        NotificationChannel ch = new NotificationChannel(CH, "Realm alerts", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Your Vigilfall Realm server: down, anti-cheat, email, backups");
        nm.createNotificationChannel(ch);
    }

    static void notify(Context c, int id, String title, String text) {
        channel(c);
        Intent open = new Intent(c, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(c, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, CH) : new Notification.Builder(c);
        b.setSmallIcon(R.drawable.ic_stat).setContentTitle(title).setContentText(text)
            .setStyle(new Notification.BigTextStyle().bigText(text)).setAutoCancel(true).setContentIntent(pi)
            .setColor(0xFFE0B860).setWhen(System.currentTimeMillis()).setShowWhen(true);
        if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
        ((NotificationManager) c.getSystemService(NOTIFICATION_SERVICE)).notify(id, b.build());
    }

    static String get(String url, String pw) throws Exception {
        HttpURLConnection h = (HttpURLConnection) new URL(url).openConnection();
        h.setConnectTimeout(15000);
        h.setReadTimeout(20000);
        h.setRequestProperty("Cache-Control", "no-cache");
        if (pw != null) h.setRequestProperty("Authorization", "Bearer " + pw);
        int code = h.getResponseCode();
        if (code == 401) throw new Exception("the admin password was changed — open the app and sign in again");
        if (code >= 400) throw new Exception("HTTP " + code);
        InputStream in = h.getInputStream();
        String s = new String(MainActivity.readAll(in), "UTF-8");
        in.close();
        return s;
    }

    static final String[][] NAMES = {
        { "cheat", "Anti-cheat" }, { "email", "Email" }, { "backup", "Backup" }, { "world", "World" }, { "server", "Server" }, { "newplayer", "New player" } };
    static String label(String k) { for (String[] n : NAMES) if (n[0].equals(k)) return n[1]; return "Realm"; }

    static synchronized void check(Context c) {
        SharedPreferences sp = prefs(c);
        if (!sp.getBoolean("on", false)) return;
        String base = sp.getString("base", ""), pw = sp.getString("pw", "");
        JSONObject kinds;
        try { kinds = new JSONObject(sp.getString("kinds", "{}")); } catch (Exception e) { kinds = new JSONObject(); }
        SharedPreferences.Editor ed = sp.edit().putLong("lastCheck", System.currentTimeMillis());
        if (base.isEmpty()) { ed.putString("lastError", "no server saved").apply(); return; }
        String host = base.replaceFirst("^https?://", "");
        // 1) is the server answering?
        try {
            get(base + "/health", null);
            if (sp.getBoolean("wasDown", false) && kinds.optInt("down", 1) == 1)
                notify(c, 1, "✅ Vigilfall Realm is back", host + " answers again.");
            ed.putInt("downCount", 0).putBoolean("wasDown", false);
        } catch (Exception e) {
            int n = sp.getInt("downCount", 0) + 1;
            ed.putInt("downCount", n).putString("lastError", "server not answering: " + e.getMessage());
            if (n == 2) {
                ed.putBoolean("wasDown", true);
                if (kinds.optInt("down", 1) == 1) notify(c, 1, "⚠ Vigilfall Realm is not answering", host + " has not answered for about 15 minutes. Open Vigilfall Admin → Console to look, or wait: it may be restarting.");
            }
            ed.apply();
            return;
        }
        // 2) what happened since the last check
        try {
            long after = sp.getLong("after", 0);
            JSONObject r = new JSONObject(get(base + "/api/alerts?after=" + after, pw));
            JSONArray items = r.optJSONArray("items");
            long seq = r.optLong("seq", after);
            if (after > 0 && items != null) {
                StringBuilder all = new StringBuilder();
                int shown = 0, nid = 100 + (int) (System.currentTimeMillis() / 1000 % 1000);
                for (int i = 0; i < items.length(); i++) {
                    JSONObject it = items.getJSONObject(i);
                    String k = it.optString("kind");
                    if (kinds.optInt(k, ("server".equals(k) || "newplayer".equals(k)) ? 0 : 1) != 1) continue;
                    String line = label(k) + ": " + it.optString("text");
                    if (shown < 3) notify(c, nid + shown, "Vigilfall · " + label(k), it.optString("text"));
                    else all.append(line).append("\n");
                    shown++;
                }
                if (shown > 3) notify(c, nid + 3, "Vigilfall · " + (shown - 3) + " more alerts", all.toString().trim());
            }
            for (int i = 0; items != null && i < items.length(); i++) seq = Math.max(seq, items.getJSONObject(i).optLong("id", 0));
            ed.putLong("after", seq).remove("lastError");
        } catch (Exception e) {
            ed.putString("lastError", e.getMessage());
        }
        ed.apply();
    }
}
