package app.conferencecaddie.ui.people

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.v2.runComposeUiTest
import app.conferencecaddie.shared.people.PeopleAvailability
import app.conferencecaddie.shared.people.PeopleController
import app.conferencecaddie.ui.shell.ShellNavigation
import app.conferencecaddie.ui.theme.CaddieTheme
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

// The most visible people actions when the phone cannot store their records (a full disk): "Save
// this person" and Unblock say why and leave things as they were, instead of claiming success.
// Run on the iOS simulator and on Android.
@OptIn(ExperimentalTestApi::class)
class NoSilentFailuresUiTest {
    private val rigs = ArrayList<U3Rig>()
    private val fixtures = ArrayList<U1Fixture>()
    private val controllers = ArrayList<PeopleController>()

    @AfterTest
    fun cleanUp() {
        controllers.forEach { it.close() }
        rigs.forEach { it.close() }
        fixtures.forEach { it.close() }
    }

    @Test
    fun saveThisPersonThatThePhoneCannotStoreSaysSoAndOffersItAgain() = runComposeUiTest {
        val records = InMemoryPeopleKeyValue()
        val rig = U3Rig(keyValue = records).also { rigs += it }
        val id = u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
            val ada = rig.seedAda("Hallway")
            check(rig.controller.turnOnPresence("Expo hall", "") == null)
            rig.activeMeet(ada)
        }
        u3Show(rig) { state -> MeetScreen(id, state, rig.host) }
        u3WaitForTag("meet-found")
        onNodeWithTag("meet-found").performScrollTo().performClick()
        u3WaitForTag("meet-found-card")

        records.failWrites = true
        onNodeWithText(ConnectStrings.SAVE_PERSON).performClick()
        u3WaitForToast(rig, PeopleCommonStrings.NOT_SAVED)
        runOnIdle {
            assertFalse(ConnectStrings.SAVED_TOAST in rig.toasts.value, "no \"Saved\"")
            assertTrue(rig.state.met.isEmpty())
        }
        onNodeWithText(ConnectStrings.SAVED_UNDER_SETTINGS).assertDoesNotExist()
        onNodeWithText(ConnectStrings.SAVE_PERSON).assertIsDisplayed().assertIsEnabled()

        // Once the phone can store it, the same button saves.
        records.failWrites = false
        onNodeWithText(ConnectStrings.SAVE_PERSON).performClick()
        u3WaitForToast(rig, ConnectStrings.SAVED_TOAST)
        u3WaitForText(ConnectStrings.SAVED_UNDER_SETTINGS)
        waitUntil(timeoutMillis = 20_000) { rig.state.met.map { it.displayName } == listOf("Ada Seed") }
    }

    /** A controller of its own over [records], following [f]'s core, and a host whose toasts (with their actions) the test reads. */
    private class Rig(val f: U1Fixture, val records: InMemoryPeopleKeyValue) {
        val controller = testPeopleController(f.server, f.scope, f.clock, keyValue = records).also { it.bind(f.core.state) }
        val toasts = MutableStateFlow<List<Pair<String, PeopleToastAction?>>>(emptyList())
        val host = PeopleHost(controller, ShellNavigation(), f.scope, { message, action -> toasts.update { it + (message to action) } }, {}, {})

        fun messages(): List<String> = toasts.value.map { it.first }
    }

    private fun androidx.compose.ui.test.ComposeUiTest.blockedCasey(): Pair<Rig, String> {
        val f = U1Fixture().also { fixtures += it }
        u1WaitReady(f)
        val rig = Rig(f, InMemoryPeopleKeyValue()).also { controllers += it.controller }
        u1WaitOrDump("the test's controller") { rig.controller.state.value.availability == PeopleAvailability.Ready }
        val casey = f.server.seedPerson(f.slug, "Casey")
        f.act {
            rig.controller.updateProfile { it.copy(displayName = "Jordan Rivera") }
            assertNull(rig.controller.setOpenToMeet(true))
        }
        setContent {
            TestPhone {
                CaddieTheme {
                    val state by rig.controller.state.collectAsState()
                    Column(Modifier.verticalScroll(rememberScrollState())) { BlockedPeople(state, rig.host) }
                }
            }
        }
        return rig to casey.ref
    }

    @Test
    fun anUnblockThatThePhoneCannotStoreKeepsTheRowAndSaysWhy() = runComposeUiTest {
        val (rig, casey) = blockedCasey()
        rig.f.act { assertNull(rig.controller.block(casey, "Casey")) }
        u1WaitForTag("unblock-$casey")
        // The list read when the group shows has come back, so it is not what fails below.
        u1WaitOrDump("the block list read") { rig.f.server.requests("GET", "/api/people/blocks").isNotEmpty() }
        rig.f.act { rig.controller.retrySession() }

        rig.records.failWrites = true
        onNodeWithTag("unblock-$casey").performClick()
        u1WaitForText(PeopleCommonStrings.NOT_SAVED)
        onNodeWithText("Casey").assertIsDisplayed()
        onNodeWithTag("unblock-$casey").assertIsEnabled()
        runOnIdle {
            assertFalse(PeopleCommonStrings.unblocked("Casey") in rig.messages(), "no \"Unblocked\"")
            assertEquals(listOf(casey), rig.controller.state.value.blocks.map { it.ref })
        }

        // Trying again once the phone can store it finishes the unblock.
        rig.records.failWrites = false
        onNodeWithTag("unblock-$casey").performClick()
        u1WaitForText(ProfileStrings.nobodyBlocked("Alpha Conference"))
        u1WaitOrDump("the toast") { PeopleCommonStrings.unblocked("Casey") in rig.messages() }
        assertTrue(rig.controller.state.value.blocks.isEmpty())
    }

    @Test
    fun anUndoOfABlockThatThePhoneCannotStoreSaysWhy() = runComposeUiTest {
        val (rig, casey) = blockedCasey()
        runOnIdle { rig.host.block(BlockTarget(casey, "Casey")) }
        u1WaitOrDump("the block's toast") { rig.toasts.value.any { it.first == PeopleCommonStrings.blocked("Casey") } }
        u1WaitForTag("unblock-$casey")
        val undo = rig.toasts.value.single { it.first == PeopleCommonStrings.blocked("Casey") }.second!!
        assertEquals(PeopleCommonStrings.UNDO, undo.label)

        rig.records.failWrites = true
        runOnIdle { undo.onClick() }
        u1WaitOrDump("the Undo's message") { PeopleCommonStrings.NOT_SAVED in rig.messages() }
        onNodeWithText("Casey").assertIsDisplayed()
        runOnIdle {
            assertFalse(PeopleCommonStrings.unblocked("Casey") in rig.messages())
            assertEquals(listOf(casey), rig.controller.state.value.blocks.map { it.ref })
        }
    }
}
