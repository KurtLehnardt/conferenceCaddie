package app.conferencecaddie.ui

import app.conferencecaddie.ui.shell.DebugLaunch
import app.conferencecaddie.ui.shell.Tab
import app.conferencecaddie.ui.shell.launchOptions
import app.conferencecaddie.ui.shell.linkBase
import app.conferencecaddie.ui.theme.ThemePreference
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

// The debug launch options: what they accept, and that release builds take none of them.
class LaunchOptionsTest {
    private fun parse(vararg pairs: Pair<String, String>) = DebugLaunch.from { name -> pairs.toMap()[name] }

    @Test
    fun optionsAreReadByNameAndUnknownValuesIgnored() {
        val launch = parse("caddie.tab" to "search", "caddie.open" to "Settings", "caddie.theme" to "DARK", "caddie.gallery" to "1")
        assertEquals(DebugLaunch(tab = Tab.Search, open = "settings", theme = ThemePreference.Dark, gallery = true), launch)
        assertEquals(DebugLaunch(), parse("caddie.tab" to "Profile", "caddie.open" to "talk", "caddie.theme" to "sepia"))
    }

    @Test
    fun theConnectOptionFollowsTheLinkRules() {
        assertEquals("https://caddie.example.org/demo", parse("caddie.connect" to "HTTPS://Caddie.Example.ORG:443/demo/").connect)
        assertNull(parse("caddie.connect" to "javascript:alert(1)").connect)
        assertNull(parse("caddie.connect" to "https://user:pw@caddie.example.org").connect)
        // Links never get the debug exception for plain http to a local server.
        assertNull(parse("caddie.connect" to "http://localhost:8080").connect)
        assertNull(linkBase("http://10.0.2.2:8080"))
        assertEquals("https://caddie.example.org", linkBase("https://caddie.example.org/"))
    }

    @Test
    fun releaseBuildsTakeNoOptions() {
        val launch = DebugLaunch(tab = Tab.Search, open = "switcher", theme = ThemePreference.Light, connect = "https://x.example", gallery = true)
        assertEquals(DebugLaunch(), launchOptions(isDebugBuild = false, launch = launch))
        assertEquals(launch, launchOptions(isDebugBuild = true, launch = launch))
    }
}
