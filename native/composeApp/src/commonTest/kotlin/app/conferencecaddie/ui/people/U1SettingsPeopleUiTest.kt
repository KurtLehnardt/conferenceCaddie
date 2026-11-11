package app.conferencecaddie.ui.people

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.runComposeUiTest
import app.conferencecaddie.shared.people.BlockedPerson
import app.conferencecaddie.shared.people.MetPerson
import app.conferencecaddie.shared.people.PushView
import app.conferencecaddie.shared.people.Watch
import app.conferencecaddie.ui.shell.ShellNavigation
import app.conferencecaddie.ui.theme.CaddieTheme
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

// The people groups of Settings (web SettingsPeople.tsx): Blocked people read from the server and
// unblocked, People I met and People I'm watching removed, and the groups in the web's order. Run
// on the iOS simulator and on Android.
@OptIn(ExperimentalTestApi::class)
class U1SettingsPeopleUiTest {
    private val f = U1Fixture()

    @AfterTest
    fun cleanUp() = f.close()

    @Test
    fun blockedMetAndWatchedPeopleCanBeRemoved() = runComposeUiTest {
        u1WaitReady(f)
        val casey = f.server.seedPerson(f.slug, "Casey")
        val devon = f.server.seedPerson(f.slug, "Devon")
        f.act {
            f.controller.updateProfile { it.copy(displayName = "Jordan Rivera") }
            assertNull(f.controller.setOpenToMeet(true))
            assertNull(f.controller.block(casey.ref, "Casey"))
            f.controller.saveMet("Avery", "Placeholder profile 1 for local development.")
            f.controller.saveMet("Blake", "")
            f.controller.toggleWatch(devon.ref, "Devon")
        }
        val me = f.server.me(f.slug)!!
        setContent {
            TestPhone {
                CaddieTheme {
                    val state by f.controller.state.collectAsState()
                    Column(Modifier.verticalScroll(rememberScrollState())) { SettingsPeople(state, f.host) }
                }
            }
        }
        u1WaitForTag("set-blocked")

        // Blocked people: read from the server as it shows, then unblocked with a toast.
        u1WaitOrDump("the block list read") { f.server.requests("GET", "/api/people/blocks").isNotEmpty() }
        onNodeWithText(ProfileStrings.BLOCKED_PEOPLE.uppercase()).assertIsDisplayed()
        onNodeWithText("Casey").assertIsDisplayed()
        onNodeWithTag("unblock-${casey.ref}").performClick()
        u1WaitForText(ProfileStrings.nobodyBlocked("Alpha Conference"))
        assertTrue(f.server.requests("DELETE", "/api/people/block").isNotEmpty())
        assertTrue(f.server.blockedBy(me).isEmpty())
        runOnIdle { assertEquals(listOf(PeopleCommonStrings.unblocked("Casey")), f.toasts) }

        // People I met: name and about over the stretched Remove, then the footer.
        onNodeWithText(ProfileStrings.PEOPLE_I_MET.uppercase()).performScrollTo().assertIsDisplayed()
        onNodeWithText("Placeholder profile 1 for local development.").assertIsDisplayed()
        onNodeWithText(ProfileStrings.SAVED_ON_PHONE).assertExists()
        val remove = onNodeWithTag("met-remove-0").fetchSemanticsNode().boundsInRoot
        val name = onNodeWithText("Avery").fetchSemanticsNode().boundsInRoot
        val density = onNodeWithTag("met-remove-0").fetchSemanticsNode().layoutInfo.density.density
        assertEquals(name.left - 12 * density, remove.left, 1.5f)
        onNodeWithTag("met-remove-0").performClick()
        u1WaitGone(hasText("Avery"))
        onNodeWithText("Blake").assertIsDisplayed()
        onNodeWithTag("met-remove-0").performClick()
        u1WaitGone(hasTestTag("set-met"))
        assertTrue(f.controller.state.value.met.isEmpty())

        // People I'm watching: Remove, and the group goes with the last one.
        onNodeWithText(ProfileStrings.WATCH_FOOTER).performScrollTo().assertIsDisplayed()
        onNodeWithText("Devon").assertIsDisplayed()
        onNodeWithTag("watch-remove-${devon.ref}").performClick()
        u1WaitGone(hasTestTag("set-watch"))
        assertTrue(f.controller.state.value.watch.isEmpty())

        // Nudges stays; Push shows only with native push.
        onNodeWithTag("set-nudges").assertExists()
        onNodeWithTag("set-push").assertDoesNotExist()
    }

    @Test
    fun groupsFollowTheWebOrderAndNamelessPeopleReadAsSomeone() = runComposeUiTest {
        val host = PeopleHost(testController(f.scope), ShellNavigation(), f.scope, { _, _ -> }, {}, {})
        val state = readyState().copy(
            blocks = listOf(BlockedPerson("r1", null)),
            met = listOf(MetPerson("Avery")),
            watch = listOf(Watch("w1", "")),
            push = PushView(available = true),
        )
        setContent {
            TestPhone { CaddieTheme { Column(Modifier.verticalScroll(rememberScrollState())) { SettingsPeople(state, host) } } }
        }
        onNodeWithText(ProfileStrings.SOMEONE_YOU_BLOCKED).assertIsDisplayed()
        onNodeWithText(ProfileStrings.SOMEONE).assertExists()
        onNodeWithText(ProfileStrings.PUSH.uppercase()).assertExists()
        val tops = listOf("set-blocked", "set-met", "set-watch", "set-nudges", "set-push").map { onNodeWithTag(it).getUnclippedBoundsInRoot().top }
        assertEquals(tops.sorted(), tops)
        assertEquals(tops.size, tops.toSet().size)
    }
}
