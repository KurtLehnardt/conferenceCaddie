package app.conferencecaddie

import android.content.pm.ApplicationInfo
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import app.conferencecaddie.ui.shell.DebugLaunch
import app.conferencecaddie.ui.shell.StandaloneShell

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // Debug builds are debuggable; release builds are not. This avoids generating BuildConfig.
        val isDebugBuild = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        // Debug launch options arrive as intent extras: am start -e caddie.tab Search ...
        val launch = DebugLaunch.from { intent?.getStringExtra(it) }
        setContent {
            StandaloneShell(isDebugBuild = isDebugBuild, launch = launch)
        }
    }
}
