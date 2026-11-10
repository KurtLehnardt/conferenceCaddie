package app.conferencecaddie

import android.os.Bundle
import androidx.activity.OnBackPressedCallback
import app.conferencecaddie.ble.CaddieBlePlugin
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // Plugins register before the bridge is created.
        registerPlugin(CaddieBlePlugin::class.java)
        super.onCreate(savedInstanceState)
        // System Back walks the web app's history: every screen is a hash route, so each tab,
        // meet or settings page is a WebView history entry. On the first screen Back sends the app
        // to the background instead of finishing it, so a running Bluetooth session carries on.
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    val webView = getBridge()?.webView
                    if (webView != null && webView.canGoBack()) {
                        webView.goBack()
                    } else {
                        moveTaskToBack(true)
                    }
                }
            },
        )
    }
}
