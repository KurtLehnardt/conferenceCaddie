package app.conferencecaddie

import android.os.Bundle
import app.conferencecaddie.ble.CaddieBlePlugin
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // Plugins register before the bridge is created.
        registerPlugin(CaddieBlePlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
