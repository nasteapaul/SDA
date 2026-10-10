package ro.budgetplanner.app;

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
import android.text.TextUtils;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;

/**
 * Budget alerts as phone notifications. Every few hours (and a minute after you log in)
 * it asks the home server for GET /api/alerts with your login and shows each alert it
 * hasn't shown before. Away from home the server can't be reached: it simply tries
 * again at the next run.
 */
public class AlertsJob extends JobService {
    static final String PREFS = "budget";
    static final String KEY_SERVER = "server";
    static final String KEY_TOKEN = "notifyToken";
    private static final String KEY_SEEN = "seenAlerts";
    private static final String KEY_PRIMED = "alertsPrimed";
    private static final String CHANNEL = "alerts";
    private static final int JOB_PERIODIC = 4101;
    private static final int JOB_SOON = 4102;
    private static final long PERIOD_MS = 3 * 60 * 60 * 1000L;
    private static final int MAX_SEEN = 300;
    private static final int FIRST_RUN_MAX = 3; // right after install: the newest few, not a flood

    /** Stores the login (empty = logged out) and schedules or cancels the checks. */
    static void setToken(Context ctx, String token) {
        String t = token == null ? "" : token.trim();
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String old = p.getString(KEY_TOKEN, "");
        p.edit().putString(KEY_TOKEN, t).apply();
        JobScheduler js = (JobScheduler) ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (js == null) return;
        if (t.isEmpty()) {
            js.cancel(JOB_PERIODIC);
            js.cancel(JOB_SOON);
            return;
        }
        ComponentName me = new ComponentName(ctx, AlertsJob.class);
        boolean scheduled = false;
        for (JobInfo j : js.getAllPendingJobs()) if (j.getId() == JOB_PERIODIC) scheduled = true;
        if (!scheduled) {
            js.schedule(new JobInfo.Builder(JOB_PERIODIC, me)
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPeriodic(PERIOD_MS)
                    .setPersisted(true)
                    .build());
        }
        if (!t.equals(old)) {
            js.schedule(new JobInfo.Builder(JOB_SOON, me)
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setMinimumLatency(60 * 1000L)
                    .setOverrideDeadline(15 * 60 * 1000L)
                    .build());
        }
    }

    @Override
    public boolean onStartJob(final JobParameters params) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    check();
                } catch (Exception ignored) {
                    // offline, server stopped, bad answer: the next run tries again
                }
                jobFinished(params, false);
            }
        }).start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true;
    }

    private void check() throws Exception {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        String server = p.getString(KEY_SERVER, null);
        String token = p.getString(KEY_TOKEN, "");
        if (server == null || token.isEmpty()) return;
        HttpURLConnection c = (HttpURLConnection) new URL(server + "/api/alerts").openConnection();
        try {
            c.setConnectTimeout(15000);
            c.setReadTimeout(15000);
            c.setUseCaches(false);
            c.setRequestProperty("Authorization", "Bearer " + token);
            c.setRequestProperty("Accept", "application/json");
            int code = c.getResponseCode();
            if (code == 401) {
                // The login expired: stop until the app shares a new one.
                setToken(getApplicationContext(), "");
                return;
            }
            if (code != 200) return;
            JSONArray alerts = new JSONObject(read(c.getInputStream())).optJSONArray("alerts");
            if (alerts == null) return;
            LinkedHashSet<String> seen = new LinkedHashSet<>(Arrays.asList(p.getString(KEY_SEEN, "").split("\n")));
            seen.remove("");
            boolean primed = p.getBoolean(KEY_PRIMED, false);
            int shown = 0;
            for (int i = 0; i < alerts.length(); i++) {
                JSONObject a = alerts.optJSONObject(i);
                if (a == null) continue;
                String id = a.optString("id", "");
                if (id.isEmpty() || seen.contains(id)) continue;
                seen.add(id);
                if (!primed && shown >= FIRST_RUN_MAX) continue;
                show(a, id);
                shown++;
            }
            List<String> keep = new ArrayList<>(seen);
            if (keep.size() > MAX_SEEN) keep = keep.subList(keep.size() - MAX_SEEN, keep.size());
            p.edit().putString(KEY_SEEN, TextUtils.join("\n", keep)).putBoolean(KEY_PRIMED, true).apply();
        } finally {
            c.disconnect();
        }
    }

    private static String read(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            if (out.size() > 1024 * 1024) break; // alerts are small; never read without limit
        }
        in.close();
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private void show(JSONObject a, String id) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Budget alerts", NotificationManager.IMPORTANCE_DEFAULT));
        }
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        open.putExtra(MainActivity.EXTRA_LINK, a.optString("link", "#overview"));
        int req = id.hashCode();
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent tap = PendingIntent.getActivity(this, req, open, flags);
        String title = a.optString("title", "Budget");
        String text = a.optString("text", "");
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        // The white launcher glyph is the small icon (resources aren't compiled into an R class here).
        int icon = getResources().getIdentifier("ic_launcher_monochrome", "mipmap", getPackageName());
        b.setSmallIcon(icon != 0 ? icon : android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setColor(0xFF2563EB)
                .setAutoCancel(true)
                .setContentIntent(tap);
        nm.notify(req, b.build());
    }
}
