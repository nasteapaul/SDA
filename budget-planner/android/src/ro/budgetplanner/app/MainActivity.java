package ro.budgetplanner.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Thin native shell around the self-hosted Budget Planner web app.
 *
 * - First launch asks for the home server address (e.g. https://budget.example.ts.net).
 * - At home: loads the live app from the server.
 * - Away from home: loads the last cached copy; the web app then shows the
 *   data it saved locally and queues edits until you are back on your Wi-Fi.
 * - Bank logins and other external links open in the real browser.
 */
public class MainActivity extends Activity {
    private static final String PREFS = "budget";
    private static final String KEY_SERVER = "server";
    private static final int REQ_FILE = 1;
    private static final int REQ_SAVE = 2;

    private final Handler main = new Handler(Looper.getMainLooper());
    private WebView web;
    private String server;
    private boolean offline;
    private boolean triedCache;
    private ValueCallback<Uri[]> fileCallback;
    private String pendingSave;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        server = prefs().getString(KEY_SERVER, null);
        if (server == null) showSetup(null);
        else startWeb();
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private boolean isNight() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    // ------------------------------------------------------------ setup screen
    private void showSetup(String message) {
        boolean night = isNight();
        int ink = night ? Color.WHITE : Color.parseColor("#0b0b0b");
        int muted = night ? Color.parseColor("#c3c2b7") : Color.parseColor("#52514e");

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(24), dp(48), dp(24), dp(24));

        TextView title = new TextView(this);
        title.setText("Connect to your budget");
        title.setTextSize(26);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextColor(ink);
        box.addView(title);

        TextView body = new TextView(this);
        body.setText("Enter the address your home server prints when it starts (\"On your Wi-Fi: https://…\", or your Tailscale address). "
                + "Your phone must be on the same Wi-Fi the first time.");
        body.setTextSize(15);
        body.setTextColor(muted);
        body.setPadding(0, dp(10), 0, dp(20));
        box.addView(body);

        final EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setImeOptions(EditorInfo.IME_ACTION_GO);
        input.setHint("https://192.168.1.50:8080");
        input.setText(server != null ? server : "https://");
        input.setSelection(input.getText().length());
        input.setTextSize(18);
        input.setTextColor(ink);
        box.addView(input, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        final TextView error = new TextView(this);
        error.setTextColor(Color.parseColor(night ? "#e66767" : "#b42424"));
        error.setTextSize(14);
        error.setPadding(0, dp(8), 0, dp(8));
        if (message != null) error.setText(message);
        box.addView(error);

        final Button connect = new Button(this);
        connect.setText("Connect");
        box.addView(connect, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        final Button anyway = new Button(this);
        anyway.setText("Save anyway (not at home right now)");
        anyway.setVisibility(View.GONE);
        box.addView(anyway, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        final View.OnClickListener tryConnect = new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                final String url = normalize(input.getText().toString());
                if (url == null) {
                    error.setText("That doesn't look like an address. Example: https://192.168.1.50:8080");
                    return;
                }
                connect.setEnabled(false);
                connect.setText("Checking…");
                error.setText("");
                checkServer(url, new Callback() {
                    @Override
                    public void done(boolean ok) {
                        connect.setEnabled(true);
                        connect.setText("Connect");
                        if (ok) {
                            saveServer(url);
                            startWeb();
                        } else {
                            error.setText("Couldn't reach " + url + ". Is the server running, and is this phone on your home Wi-Fi?");
                            anyway.setVisibility(View.VISIBLE);
                        }
                    }
                });
            }
        };
        connect.setOnClickListener(tryConnect);
        input.setOnEditorActionListener(new TextView.OnEditorActionListener() {
            @Override
            public boolean onEditorAction(TextView v, int actionId, android.view.KeyEvent event) {
                tryConnect.onClick(v);
                return true;
            }
        });
        anyway.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                String url = normalize(input.getText().toString());
                if (url == null) return;
                saveServer(url);
                startWeb();
            }
        });

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.addView(box);
        if (web != null) {
            ViewGroup parent = (ViewGroup) web.getParent();
            if (parent != null) parent.removeView(web);
        }
        setContentView(scroll);
    }

    private static String normalize(String raw) {
        String s = raw == null ? "" : raw.trim();
        if (s.isEmpty()) return null;
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "https://" + s;
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        Uri u = Uri.parse(s);
        if (u.getHost() == null || u.getHost().isEmpty()) return null;
        return s;
    }

    private void saveServer(String url) {
        boolean changed = server != null && !server.equals(url);
        server = url;
        prefs().edit().putString(KEY_SERVER, url).apply();
        if (changed && web != null) web.clearCache(true);
    }

    // ------------------------------------------------------------ reachability
    interface Callback {
        void done(boolean ok);
    }

    private void checkServer(final String url, final Callback cb) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                boolean ok = false;
                HttpURLConnection c = null;
                try {
                    c = (HttpURLConnection) new URL(url + "/api/health").openConnection();
                    c.setConnectTimeout(2500);
                    c.setReadTimeout(3000);
                    c.setUseCaches(false);
                    ok = c.getResponseCode() == 200;
                } catch (Exception ignored) {
                    ok = false;
                } finally {
                    if (c != null) c.disconnect();
                }
                final boolean result = ok;
                main.post(new Runnable() {
                    @Override
                    public void run() {
                        cb.done(result);
                    }
                });
            }
        }).start();
    }

    // ------------------------------------------------------------ web app
    private void startWeb() {
        if (web == null) createWebView();
        ViewGroup parent = (ViewGroup) web.getParent();
        if (parent != null) parent.removeView(web);
        setContentView(web);
        checkServer(server, new Callback() {
            @Override
            public void done(boolean ok) {
                load(ok);
            }
        });
    }

    private void load(boolean reachable) {
        offline = !reachable;
        triedCache = false;
        web.getSettings().setCacheMode(reachable ? WebSettings.LOAD_DEFAULT : WebSettings.LOAD_CACHE_ELSE_NETWORK);
        web.loadUrl(server + "/");
        if (!reachable) Toast.makeText(this, "Not on your home Wi-Fi — showing saved data", Toast.LENGTH_SHORT).show();
    }

    private void createWebView() {
        web = new WebView(this);
        web.setBackgroundColor(isNight() ? Color.parseColor("#0d0d0d") : Color.parseColor("#f6f6f3"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setSupportZoom(false);
        s.setUserAgentString(s.getUserAgentString() + " BudgetPlannerApp/1.0");
        web.addJavascriptInterface(new Bridge(), "BudgetApp");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if ("budgetapp".equals(url.getScheme())) {
                    if ("setup".equals(url.getHost())) showSetup(null);
                    else startWeb();
                    return true;
                }
                if (sameOrigin(url)) return false;
                openExternal(url);
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                if (!triedCache) {
                    // Server unreachable: fall back to the copy saved on the phone.
                    triedCache = true;
                    offline = true;
                    view.getSettings().setCacheMode(WebSettings.LOAD_CACHE_ONLY);
                    view.loadUrl(server + "/");
                } else {
                    showOfflinePage(view);
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(pick, "Choose a bank statement (CSV)"), REQ_FILE);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });
    }

    private boolean sameOrigin(Uri url) {
        Uri base = Uri.parse(server);
        return eq(url.getScheme(), base.getScheme()) && eq(url.getHost(), base.getHost()) && port(url) == port(base);
    }

    private static boolean eq(String a, String b) {
        return a != null && a.equalsIgnoreCase(b);
    }

    private static int port(Uri u) {
        if (u.getPort() != -1) return u.getPort();
        return "https".equalsIgnoreCase(u.getScheme()) ? 443 : 80;
    }

    private void openExternal(Uri url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, url));
            if (url.getHost() != null && !url.getHost().isEmpty()) {
                Toast.makeText(this, "Opened in your browser. Come back here when you're done.", Toast.LENGTH_LONG).show();
            }
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "No app can open this link", Toast.LENGTH_SHORT).show();
        }
    }

    private void showOfflinePage(WebView view) {
        boolean night = isNight();
        String bg = night ? "#0d0d0d" : "#f6f6f3";
        String ink = night ? "#ffffff" : "#0b0b0b";
        String muted = night ? "#c3c2b7" : "#52514e";
        String html = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
                + "<body style='margin:0;font-family:system-ui,sans-serif;background:" + bg + ";color:" + ink + ";display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px;box-sizing:border-box'>"
                + "<div><div style='font-size:48px'>📡</div><h2>Can't reach your budget server</h2>"
                + "<p style='color:" + muted + "'>Connect to your home Wi-Fi and make sure the server is running at<br><b>" + escape(server) + "</b></p>"
                + "<p><a href='budgetapp://retry' style='display:inline-block;background:#2a78d6;color:#fff;padding:12px 22px;border-radius:12px;text-decoration:none;font-weight:600'>Try again</a></p>"
                + "<p><a href='budgetapp://setup' style='color:#2a78d6'>Change server address</a></p></div></body>";
        view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    private static String escape(String s) {
        return s == null ? "" : s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web == null || server == null || web.getParent() == null) return;
        checkServer(server, new Callback() {
            @Override
            public void done(boolean ok) {
                if (ok && offline) {
                    // Back on the home Wi-Fi: switch to the live app.
                    load(true);
                } else if (!ok && !offline) {
                    offline = true;
                    web.getSettings().setCacheMode(WebSettings.LOAD_CACHE_ELSE_NETWORK);
                }
            }
        });
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.getParent() != null && web.canGoBack()) web.goBack();
        else if (web != null && web.getParent() == null && server != null) startWeb();
        else super.onBackPressed();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) result = new Uri[]{data.getData()};
            if (fileCallback != null) fileCallback.onReceiveValue(result);
            fileCallback = null;
        } else if (requestCode == REQ_SAVE) {
            String content = pendingSave;
            pendingSave = null;
            if (resultCode != RESULT_OK || data == null || data.getData() == null || content == null) return;
            try {
                OutputStream out = getContentResolver().openOutputStream(data.getData());
                out.write(content.getBytes(StandardCharsets.UTF_8));
                out.close();
                Toast.makeText(this, "Saved", Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                Toast.makeText(this, "Couldn't save the file: " + e.getMessage(), Toast.LENGTH_LONG).show();
            }
        }
    }

    // ------------------------------------------------------------ JS bridge
    /** Exposed to the web app as window.BudgetApp. */
    class Bridge {
        @JavascriptInterface
        public String getServer() {
            return server;
        }

        @JavascriptInterface
        public String version() {
            return "1.0";
        }

        @JavascriptInterface
        public void changeServer() {
            main.post(new Runnable() {
                @Override
                public void run() {
                    showSetup(null);
                }
            });
        }

        @JavascriptInterface
        public void saveFile(final String name, final String mime, final String content) {
            main.post(new Runnable() {
                @Override
                public void run() {
                    pendingSave = content;
                    Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    save.addCategory(Intent.CATEGORY_OPENABLE);
                    save.setType(mime);
                    save.putExtra(Intent.EXTRA_TITLE, name);
                    try {
                        startActivityForResult(save, REQ_SAVE);
                    } catch (ActivityNotFoundException e) {
                        pendingSave = null;
                        Toast.makeText(MainActivity.this, "No app available to save files", Toast.LENGTH_SHORT).show();
                    }
                }
            });
        }
    }
}
