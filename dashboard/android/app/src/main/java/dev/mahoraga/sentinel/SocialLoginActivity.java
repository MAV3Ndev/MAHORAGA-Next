package dev.mahoraga.sentinel;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * In-app login WebView that captures session cookies (including HttpOnly)
 * once the required cookies for the provider are present.
 */
public class SocialLoginActivity extends Activity {

    public static final String EXTRA_PROVIDER = "provider";
    public static final String EXTRA_URL = "url";
    public static final String EXTRA_COOKIE_URLS = "cookieUrls";
    public static final String EXTRA_REQUIRED_COOKIES = "requiredCookies";
    public static final String EXTRA_AUTH_PROBE_URL = "authProbeUrl";
    public static final String RESULT_COOKIES = "cookies";

    private static final int POLL_INTERVAL_MS = 800;
    private static final int PROBE_INTERVAL_MS = 2000;

    private WebView webView;
    private Handler handler;
    private boolean finished;
    private volatile boolean probing;
    private long lastProbeAt;
    private String authProbeUrl;
    private String userAgent;
    private List<String> cookieUrls = new ArrayList<>();
    private List<String> requiredCookies = new ArrayList<>();

    private final Runnable poller =
        new Runnable() {
            @Override
            public void run() {
                if (finished) return;
                checkCookies();
                handler.postDelayed(this, POLL_INTERVAL_MS);
            }
        };

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Intent intent = getIntent();
        String provider = intent.getStringExtra(EXTRA_PROVIDER);
        String url = intent.getStringExtra(EXTRA_URL);
        cookieUrls = intent.getStringArrayListExtra(EXTRA_COOKIE_URLS);
        requiredCookies = intent.getStringArrayListExtra(EXTRA_REQUIRED_COOKIES);
        String probeUrl = intent.getStringExtra(EXTRA_AUTH_PROBE_URL);
        if (probeUrl != null && probeUrl.startsWith("https://")) authProbeUrl = probeUrl;
        if (cookieUrls == null) cookieUrls = new ArrayList<>();
        if (requiredCookies == null) requiredCookies = new ArrayList<>();

        if (url == null || cookieUrls.isEmpty() || requiredCookies.isEmpty()) {
            setResult(RESULT_CANCELED);
            finish();
            return;
        }

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(11, 13, 18));

        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(android.view.Gravity.CENTER_VERTICAL);
        int padding = dp(14);
        header.setPadding(padding, dp(10), padding, dp(10));
        header.setBackgroundColor(Color.rgb(18, 20, 26));

        TextView title = new TextView(this);
        title.setText("Sign in — " + (provider == null ? "Account" : capitalize(provider)));
        title.setTextColor(Color.rgb(226, 228, 235));
        title.setTextSize(15);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        header.addView(title, titleParams);

        Button cancel = new Button(this);
        cancel.setText("Cancel");
        cancel.setTextColor(Color.rgb(150, 155, 170));
        cancel.setBackgroundColor(Color.TRANSPARENT);
        cancel.setOnClickListener((View v) -> finishCancelled());
        header.addView(cancel);

        webView = new WebView(this);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        userAgent =
            "Mozilla/5.0 (Linux; Android " + Build.VERSION.RELEASE + "; " + Build.MODEL
                + ") AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
        webView.getSettings().setUserAgentString(userAgent);
        cookieManager.setAcceptThirdPartyCookies(webView, true);
        webView.setWebViewClient(
            new WebViewClient() {
                @Override
                public void onPageFinished(WebView view, String url) {
                    checkCookies();
                }
            }
        );

        root.addView(header, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(webView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);
        getWindow().setStatusBarColor(Color.rgb(11, 13, 18));

        handler = new Handler(Looper.getMainLooper());
        webView.loadUrl(url);
        handler.postDelayed(poller, POLL_INTERVAL_MS);
    }

    private void checkCookies() {
        if (finished) return;

        CookieManager cookieManager = CookieManager.getInstance();
        Map<String, String> collected = new LinkedHashMap<>();
        for (String cookieUrl : cookieUrls) {
            String raw = cookieManager.getCookie(cookieUrl);
            if (raw == null) continue;
            for (String pair : raw.split(";")) {
                String trimmed = pair.trim();
                int separator = trimmed.indexOf('=');
                if (separator <= 0) continue;
                collected.putIfAbsent(trimmed.substring(0, separator), trimmed);
            }
        }

        boolean ready = false;
        for (String required : requiredCookies) {
            if (collected.containsKey(required)) {
                ready = true;
                break;
            }
        }
        if (!ready) return;

        String cookies = TextUtils.join("; ", collected.values());
        if (authProbeUrl != null) {
            startAuthProbe(cookies);
            return;
        }
        finishCapture(cookies);
    }

    private void finishCapture(String cookies) {
        if (finished) return;
        finished = true;
        CookieManager.getInstance().flush();
        Intent result = new Intent();
        result.putExtra(RESULT_COOKIES, cookies);
        setResult(RESULT_OK, result);
        finish();
    }

    private void startAuthProbe(String cookieHeader) {
        long now = System.currentTimeMillis();
        if (probing || now - lastProbeAt < PROBE_INTERVAL_MS) return;
        probing = true;
        lastProbeAt = now;
        new Thread(() -> {
            boolean authenticated = probeAuth(authProbeUrl, cookieHeader, userAgent);
            handler.post(() -> {
                probing = false;
                if (authenticated) finishCapture(cookieHeader);
            });
        }).start();
    }

    private boolean probeAuth(String probeUrl, String cookieHeader, String ua) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(probeUrl).openConnection();
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Cookie", cookieHeader);
            if (ua != null) conn.setRequestProperty("User-Agent", ua);
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            int code = conn.getResponseCode();
            return code >= 200 && code < 300;
        } catch (Exception e) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void finishCancelled() {
        finished = true;
        setResult(RESULT_CANCELED);
        finish();
    }

    @Override
    public void onDestroy() {
        if (handler != null) handler.removeCallbacks(poller);
        if (webView != null) {
            webView.stopLoading();
            webView.clearHistory();
            webView.clearCache(true);
            webView.destroy();
        }
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.removeAllCookies(null);
        cookieManager.flush();
        WebStorage.getInstance().deleteAllData();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        finishCancelled();
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }

    private String capitalize(String value) {
        if (value == null || value.isEmpty()) return "";
        return value.substring(0, 1).toUpperCase() + value.substring(1);
    }
}
