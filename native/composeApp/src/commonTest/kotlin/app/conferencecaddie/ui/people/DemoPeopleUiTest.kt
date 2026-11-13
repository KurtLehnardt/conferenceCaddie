package app.conferencecaddie.ui.people

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.v2.runComposeUiTest
import app.conferencecaddie.shared.Demo
import app.conferencecaddie.ui.components.DEMO_NOTE_TAG
import app.conferencecaddie.ui.theme.Caddie
import app.conferencecaddie.ui.theme.CaddieTheme
import kotlin.math.abs
import kotlin.test.AfterTest
import kotlin.test.Test

// The Demo note on the people screens of a demo conference: the People tab (with "See who" still
// centring the right card), Settings' people groups and the offline state. Run on the iOS simulator
// and on Android, as the other U2 tests are.
@OptIn(ExperimentalTestApi::class)
class DemoPeopleUiTest {
    private val rig = U2Rig()

    @AfterTest
    fun cleanUp() = rig.close()

    private fun ComposeUiTest.waitForNote() {
        waitUntil(timeoutMillis = 20_000) { onAllNodes(hasTestTag(DEMO_NOTE_TAG)).fetchSemanticsNodes().isNotEmpty() }
    }

    /** [content] with this rig's PeopleHost, on the test phone in the light theme. */
    private fun ComposeUiTest.showWithHost(content: @Composable (PeopleHost) -> Unit) {
        setContent {
            val scope = rememberCoroutineScope()
            val host = remember {
                PeopleHost(rig.controller, rig.nav, scope, { message, _ -> rig.toasts += message }, {}, { rig.opened += it }).also { rig.host = it }
            }
            TestPhone {
                CaddieTheme {
                    Box(Modifier.fillMaxSize().background(Caddie.colors.bg)) { content(host) }
                }
            }
        }
    }

    @Test
    fun thePeopleTabOfADemoConferenceOpensWithTheNote() = runComposeUiTest {
        u2Ready(rig, demo = true)
        u2Show(rig)
        waitForNote()
        onNode(hasText(Demo.NOTE) and hasAnyAncestor(hasTestTag("people-screen")), useUnmergedTree = true).assertExists()
    }

    @Test
    fun thePeopleTabOfARealConferenceHasNoNote() = runComposeUiTest {
        u2Ready(rig)
        u2Show(rig)
        u2WaitForTag("people-screen")
        waitForIdle()
        onNode(hasTestTag(DEMO_NOTE_TAG)).assertDoesNotExist()
    }

    @Test
    fun seeWhoCentresTheRightCardAtADemoConference() = runComposeUiTest {
        u2Ready(rig, zone = "Hallway", demo = true)
        // Twelve people around, in this order, so the sixth can be brought to the middle.
        val refs = (1..12).map { "a0000000000000${it.toString().padStart(2, '0')}" }
        rig.matches = { u2CraftedPage(*refs.mapIndexed { i, ref -> u2CraftedPerson(ref, "Person ${i + 1}", around = true, zone = "Expo hall") }.toTypedArray()) }
        val target = refs[5]
        var reveal by mutableStateOf<String?>(null)
        u2Show(rig) { if (reveal != null) it.copy(reveal = reveal) else it }
        u2WaitForTag("person-${refs.first()}")
        waitForNote()
        reveal = target
        u2WaitForTag("person-$target")
        // The note sits inside the list's first item, so the reveal's item index still lands on the
        // card asked for: its middle ends up at the middle of the list, not a card away.
        waitUntil(timeoutMillis = 20_000) {
            val list = onNodeWithTag("people-screen").fetchSemanticsNode().boundsInRoot
            val card = onAllNodes(hasTestTag("person-$target")).fetchSemanticsNodes().firstOrNull()?.boundsInRoot ?: return@waitUntil false
            abs(card.center.y - list.center.y) < card.height / 2
        }
    }

    @Test
    fun settingsPeopleGroupsOfADemoConferenceOpenWithTheNote() = runComposeUiTest {
        u2Ready(rig, demo = true)
        showWithHost { host ->
            val state by rig.controller.state.collectAsState()
            Column { SettingsPeople(state, host) }
        }
        waitForNote()
        u2WaitForTag("set-blocked")
    }

    @Test
    fun settingsPeopleGroupsOfARealConferenceHaveNoNote() = runComposeUiTest {
        u2Ready(rig)
        showWithHost { host ->
            val state by rig.controller.state.collectAsState()
            Column { SettingsPeople(state, host) }
        }
        u2WaitForTag("set-blocked")
        onNode(hasTestTag(DEMO_NOTE_TAG)).assertDoesNotExist()
    }

    @Test
    fun theOfflinePeopleTabOfADemoConferenceKeepsTheNote() = runComposeUiTest {
        u2Ready(rig, demo = true)
        showWithHost { host ->
            val state by rig.controller.state.collectAsState()
            PeopleTab(state, host, rig.talks, online = false)
        }
        u2WaitForTag("people-offline")
        waitForNote()
        onNode(hasTestTag(DEMO_NOTE_TAG) and hasAnyAncestor(hasTestTag("people-offline"))).assertExists()
    }
}
