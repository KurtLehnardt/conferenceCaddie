package app.conferencecaddie.ui.people

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.v2.runComposeUiTest
import app.conferencecaddie.shared.people.PeopleController
import app.conferencecaddie.shared.people.PeopleText
import app.conferencecaddie.ui.shell.DebugLaunch
import app.conferencecaddie.ui.shell.ShellNavigation
import app.conferencecaddie.ui.shell.Tab
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.talks.CaddieApp
import app.conferencecaddie.ui.talks.TalkLaunch
import app.conferencecaddie.ui.theme.CaddieTheme
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive

// The talk circles (web TalkPeopleControls.tsx, ShareAllControls.tsx and the EndedTalkBanner of
// PeopleScreen.tsx): sharing from the talk sheet, the circle and its privacy, sharing every marked
// talk from Interested, and the ended-talk banner. The app is CaddieApp on TestBackend with a real
// controller over the in-memory People API. Run on the iOS simulator and on Android.
@OptIn(ExperimentalTestApi::class)
class U1TalkPeopleUiTest {
    private val f = U1Fixture()
    private val talk1 = "alpha-conf-2099:1"
    private val talk3 = "alpha-conf-2099:3"
    private val talk4 = "alpha-conf-2099:4"

    @AfterTest
    fun cleanUp() = f.close()

    /** People ready, a named profile on this device (visible to nobody yet), and [interested] marked. */
    private fun ComposeUiTest.prepare(vararg interested: String) {
        u1WaitReady(f)
        f.act { f.controller.updateProfile { it.copy(displayName = "Jordan Rivera", about = "Platform engineer.") } }
        interested.forEach { f.core.setInterested(it, true) }
        u1WaitOrDump("the Interested list") {
            f.core.state.value.interested.containsAll(interested.toList()) && f.controller.state.value.profile.displayName == "Jordan Rivera"
        }
    }

    private fun sharedIdsOfLastPut(): Set<String> =
        (f.server.requests("PUT", "/api/people/profile").last().body!!["shared_talk_ids"] as JsonArray).map { it.jsonPrimitive.content }.toSet()

    @Test
    fun sharingForATalkInTheSheetOpensItsCircle() = runComposeUiTest {
        // Avery is around in Hall A and shares for talk 1; I am not around.
        f.server.seedPerson(f.slug, "Sample · Avery", about = "Placeholder profile 1.", sharedTalkIds = listOf(talk1), around = "Hall A")
        prepare(talk1)
        setContent { TestPhone { CaddieApp(f.core, isDebugBuild = false, appVersion = "test", talkLaunch = TalkLaunch(talk = talk1), people = f.controller) } }
        u1WaitForTag("talk-sheet")
        val controls = hasAnyAncestor(hasTestTag("talk-people-$talk1"))
        u1WaitForNode(hasText(u1CountLabel(1)) and controls)

        // The first share asks first; nothing is sent until "Share my profile".
        onNodeWithText(ProfileStrings.SHARE_FOR_TALK).performScrollTo().performClick()
        u1WaitForTag("share-notice")
        onNodeWithText(PeopleText.SHARE_NOTICE).assertExists()
        assertTrue(f.server.requests("PUT", "/api/people/profile").isEmpty())
        onNodeWithText(ProfileStrings.SHARE_MY_PROFILE).performScrollTo().performClick()
        u1WaitOrDump("the share") { f.controller.state.value.visibility.sharedTalkIds == listOf(talk1) }
        assertEquals(setOf(talk1), sharedIdsOfLastPut())
        assertEquals(JsonPrimitive(false), f.server.requests("PUT", "/api/people/profile").last().body!!["open_to_meet"])
        u1WaitGone(hasTestTag("share-notice"))
        u1WaitForNode(hasText(u1CountLabel(2)) and controls)

        // See who's here: the speakers, then the others who shared.
        onNodeWithTag("see-who-$talk1").performScrollTo().performClick()
        u1WaitForTag("circle-$talk1")
        val inCircle = hasAnyAncestor(hasTestTag("circle-$talk1"))
        u1WaitForNode(hasText("Sample · Avery") and inCircle).performScrollTo().assertIsDisplayed()
        onNode(hasText(ProfileStrings.OTHERS_WHO_SHARED.uppercase()) and inCircle).assertExists()
        onNode(hasText(ProfileStrings.SPEAKERS.uppercase()) and inCircle).assertExists()
        onNode(hasText("Ada Lovelace") and inCircle).assertExists()
        // Privacy: while I am not around, a member's card shows no zone.
        onAllNodes(hasText("Hall A", substring = true) and inCircle, useUnmergedTree = true).assertCountEquals(0)

        // Stop sharing: the circle closes and the count drops back.
        onNodeWithText(ProfileStrings.SHARE_FOR_TALK).performScrollTo().performClick()
        u1WaitOrDump("the unshare") { f.controller.state.value.visibility.sharedTalkIds.isEmpty() }
        u1WaitGone(hasTestTag("circle-$talk1"))
        onNodeWithTag("see-who-$talk1").assertDoesNotExist()
        u1WaitForNode(hasText(u1CountLabel(1)) and controls)
    }

    @Test
    fun shareAllOnInterestedSharesEveryMarkedTalk() = runComposeUiTest {
        prepare(talk1, talk3)
        setContent { TestPhone { CaddieApp(f.core, isDebugBuild = false, appVersion = "test", launch = DebugLaunch(tab = Tab.Interested), people = f.controller) } }
        u1WaitForTag("share-all")
        onNodeWithText(ProfileStrings.SHARE_ALL_TITLE).assertIsDisplayed()
        u1WaitForText(ProfileStrings.shareSummary(0, 2))
        onNodeWithText(ProfileStrings.STOP_SHARING_ALL).assertDoesNotExist()

        onNodeWithText(ProfileStrings.shareForAll(2)).performClick()
        u1WaitForTag("share-notice")
        onNodeWithText(ProfileStrings.SHARE_MY_PROFILE).performClick()
        u1WaitForText(ProfileStrings.shareSummary(2, 2))
        assertEquals(setOf(talk1, talk3), sharedIdsOfLastPut())
        onNodeWithText(ProfileStrings.shareForAll(2)).assertDoesNotExist()

        // Shared for nothing and not visible: the server copy is deleted rather than written.
        onNodeWithText(ProfileStrings.STOP_SHARING_ALL).performClick()
        u1WaitForText(ProfileStrings.shareSummary(0, 2))
        u1WaitOrDump("the server copy to go") { f.server.me(f.slug) == null }
        assertTrue(f.controller.state.value.visibility.sharedTalkIds.isEmpty())

        // The notice has been seen, so following the list shares everything marked at once.
        onNodeWithText(ProfileStrings.SHARE_AUTOMATICALLY).performClick()
        u1WaitOrDump("following Interested") { f.controller.state.value.visibility.shareNew }
        u1WaitForText(ProfileStrings.shareSummary(2, 2))
        onNodeWithTag("share-notice").assertDoesNotExist()

        // Off again: the shares made so far stay.
        onNodeWithText(ProfileStrings.SHARE_AUTOMATICALLY).performClick()
        u1WaitOrDump("not following") { !f.controller.state.value.visibility.shareNew }
        onNodeWithText(ProfileStrings.shareSummary(2, 2)).assertExists()
    }

    @Test
    fun theEndedTalkBannerOpensTheCircleInPlace() = runComposeUiTest {
        f.server.seedPerson(f.slug, "Sample · Blake", sharedTalkIds = listOf(talk1))
        prepare(talk1, talk3)
        val bundle = f.bundle!!
        val end1 = bundle.talksById.getValue(talk1).endEpochMs
        var now by mutableLongStateOf(end1 - 60_000)
        setContent {
            TestPhone {
                CaddieTheme {
                    val state by f.controller.state.collectAsState()
                    Column(Modifier.verticalScroll(rememberScrollState())) {
                        EndedTalkBanner(PeopleTalks(bundle, listOf(talk1, talk3), now), state, f.host)
                    }
                }
            }
        }
        // Nothing until a marked talk has ended.
        waitForIdle()
        onNodeWithTag("ended-talk-banner").assertDoesNotExist()
        now = end1 + 60_000
        u1WaitForTag("ended-talk-banner")
        onNodeWithText("${ProfileStrings.ENDED_LEAD}Intro to eBPF tracing${ProfileStrings.ENDED_TAIL}").assertIsDisplayed()

        onNodeWithTag("ended-open-talk").performClick()
        runOnIdle { assertEquals(listOf(talk1), f.openedTalks) }

        // "See who else was interested" marks it seen but keeps it, with the talk's controls in place
        // of the actions.
        onNodeWithTag("ended-see-who").performClick()
        u1WaitOrDump("the banner seen") { talk1 in f.controller.state.value.visibility.bannerSeen }
        u1WaitForTag("talk-people-$talk1")
        onNodeWithTag("ended-see-who").assertDoesNotExist()
        u1WaitForNode(hasText(u1CountLabel(1)))

        // Sharing opens the circle at once.
        onNodeWithText(ProfileStrings.SHARE_FOR_TALK).performClick()
        onNodeWithText(ProfileStrings.SHARE_MY_PROFILE).performClick()
        u1WaitForTag("circle-$talk1")
        u1WaitForNode(hasText("Sample · Blake") and hasAnyAncestor(hasTestTag("circle-$talk1")))

        // Close: the banner goes and, being seen, does not come back.
        onNode(hasContentDescription(Strings.Common.CLOSE) and hasAnyAncestor(hasTestTag("ended-talk-banner"))).performClick()
        u1WaitGone(hasTestTag("ended-talk-banner"))
    }

    @Test
    fun theControllersNoticeOffersOpenProfileOnlyWhenItSaysSo() = runComposeUiTest {
        prepare(talk1)
        f.act { assertNull(f.controller.followInterested()) }
        val toasts = ArrayList<Pair<String, String?>>()
        setContent {
            rememberPeopleUi(
                f.controller,
                ShellNavigation(),
                PeopleTalks(null, emptyList(), 0),
                online = true,
                searchable = true,
                launch = null,
                showToast = { message, label, _ -> toasts += message to label },
                openTalk = {},
                openUrl = {},
            )
        }

        // A LinkedIn link the server would refuse: the automatic share of the next marked talk fails
        // with a message that does not say "profile", yet the fix is on Profile, so the toast offers it.
        f.act { f.controller.updateProfile { it.copy(linkedinUrl = "https://example.com/in/jordan") } }
        val problem = PeopleController.profileProblem(f.controller.state.value.profile)!!
        assertFalse(problem.contains("profile", ignoreCase = true))
        f.core.setInterested(talk3, true)
        u1WaitOrDump("the LinkedIn notice") { toasts.isNotEmpty() }
        runOnIdle { assertEquals(listOf<Pair<String, String?>>(problem to PeopleCommonStrings.OPEN_PROFILE), toasts.toList()) }
        u1WaitOrDump("the notice to be cleared") { f.controller.state.value.notice == null }

        // A server that is down: the toast names the failure and offers nothing.
        f.act { f.controller.updateProfile { it.copy(linkedinUrl = "") } }
        f.server.failure = FakeFailure.ServerError()
        f.core.setInterested(talk4, true)
        u1WaitOrDump("the server notice") { toasts.size == 2 }
        runOnIdle {
            val (message, label) = toasts[1]
            assertFalse(message.contains("profile", ignoreCase = true))
            assertNull(label)
        }
        f.server.failure = FakeFailure.None
    }
}
