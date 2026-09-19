package dev.mahoraga.sentinel;

import android.app.Activity;
import android.content.Intent;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;

@CapacitorPlugin(name = "SocialLogin")
public class SocialLoginPlugin extends Plugin {

    @PluginMethod
    public void openLogin(PluginCall call) {
        String provider = call.getString("provider", "account");
        String url = call.getString("url");
        List<String> cookieUrls = toStringList(call.getArray("cookieUrls"));
        List<String> requiredCookies = toStringList(call.getArray("requiredCookies"));

        if (url == null || !url.startsWith("https://") || cookieUrls.isEmpty() || requiredCookies.isEmpty()) {
            call.reject("invalid_request", "url, cookieUrls, and requiredCookies are required.");
            return;
        }

        Intent intent = new Intent(getContext(), SocialLoginActivity.class);
        intent.putExtra(SocialLoginActivity.EXTRA_PROVIDER, provider);
        intent.putExtra(SocialLoginActivity.EXTRA_URL, url);
        intent.putExtra(SocialLoginActivity.EXTRA_AUTH_PROBE_URL, call.getString("authProbeUrl"));
        intent.putStringArrayListExtra(SocialLoginActivity.EXTRA_COOKIE_URLS, new ArrayList<>(cookieUrls));
        intent.putStringArrayListExtra(SocialLoginActivity.EXTRA_REQUIRED_COOKIES, new ArrayList<>(requiredCookies));
        startActivityForResult(call, intent, "handleLoginResult");
    }

    @ActivityCallback
    private void handleLoginResult(PluginCall call, ActivityResult result) {
        if (call == null) return;

        JSObject output = new JSObject();
        Intent data = result.getData();
        if (result.getResultCode() == Activity.RESULT_OK && data != null) {
            output.put("cookies", data.getStringExtra(SocialLoginActivity.RESULT_COOKIES));
        } else {
            output.put("cancelled", true);
        }
        call.resolve(output);
    }

    private List<String> toStringList(JSArray array) {
        List<String> values = new ArrayList<>();
        if (array == null) return values;
        try {
            for (Object value : array.toList()) {
                if (value != null) values.add(String.valueOf(value));
            }
        } catch (Exception ignored) {
            // Treat malformed arrays as empty.
        }
        return values;
    }
}
