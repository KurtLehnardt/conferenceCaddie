package app.conferencecaddie.ui.people

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.runComposeUiTest
import app.conferencecaddie.shared.people.ApiResult
import app.conferencecaddie.shared.people.PeopleText
import app.conferencecaddie.ui.shell.PeoplePage
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

// PersonCard (web PersonCard.tsx, BroadLine.tsx) on the People home, over the real controller and
// FakePeopleServer: the one action in the web's priority, the watch toggle, Block from the overflow
// menu, and the card's blocks (topics, How to reach me, the broad and sample variants). Run on the
// iOS simulator and on Android.
@OptIn(ExperimentalTestApi::class)
class PersonCardUiTest {
    private val rig = U2Rig()

    @AfterTest
    fun cleanUp() = rig.close()

    @Test
    fun theActionFollowsTheWebsPriority() = runComposeUiTest {
        u2Ready(rig, zone = "Hallway")
        val ada = rig.server.seedPerson(rig.slug, "Ada Seed", expertise = "Ran eBPF tracing.", speakTopics = listOf("ebpf"), around = "Hallway")
        val bea = rig.server.seedPerson(rig.slug, "Bea Seed", expertise = "Wrote eBPF maps.", speakTopics = listOf("ebpf"), around = "Expo hall")
        val dee = rig.server.seedPerson(rig.slug, "Dee Seed", expertise = "Tuned eBPF probes.", speakTopics = listOf("ebpf"), around = "Expo hall")
        u2Show(rig)
        u2WaitForTag("person-${ada.ref}")
        // In my zone: Wave. Around elsewhere: Ask to talk shop.
        onNode(u2InCard(ada.ref, PeopleStrings.WAVE)).assertIsDisplayed()
        u2ScrollToCard(bea.ref)
        onNode(u2InCard(bea.ref, PeopleStrings.ASK_TO_TALK_SHOP)).assertExists()
        u2ScrollToCard(dee.ref)
        onNode(u2InCard(dee.ref, PeopleStrings.ASK_TO_TALK_SHOP)).assertExists()

        // My ask waits for an answer: "No reply yet".
        val asked = u2Await(rig) { rig.controller.ask(rig.state.around.people.first { it.ref == bea.ref }, "Want to compare eBPF notes?") }
        assertTrue(asked is ApiResult.Ok)
        u2ScrollToCard(bea.ref)
        waitUntil(timeoutMillis = 20_000) { onAllNodes(u2InCard(bea.ref, PeopleCommonStrings.NO_REPLY_YET)).fetchSemanticsNodes().isNotEmpty() }
        onAllNodes(u2InCard(bea.ref, PeopleStrings.ASK_TO_TALK_SHOP)).assertCountEquals(0)

        // They accepted: "Open meet-up" opens it.
        val meet = (u2Await(rig) { rig.controller.ask(rig.state.around.people.first { it.ref == dee.ref }, "Probes?") } as ApiResult.Ok).value
        dee.accept(meet.meetId)
        u2Await(rig) { rig.controller.refreshInbox() }
        u2ScrollToCard(dee.ref)
        waitUntil(timeoutMillis = 20_000) { onAllNodes(u2InCard(dee.ref, PeopleCommonStrings.OPEN_MEET_UP)).fetchSemanticsNodes().isNotEmpty() }
        onNode(u2InCard(dee.ref, PeopleCommonStrings.OPEN_MEET_UP)).performClick()
        runOnIdle { assertEquals(listOf<PeoplePage>(PeoplePage.Meet(meet.meetId)), rig.nav.pages) }

        // Wave: one tap with the web's note, then "Waved".
        u2ScrollToCard(ada.ref)
        onNode(u2InCard(ada.ref, PeopleStrings.WAVE)).performClick()
        waitUntil(timeoutMillis = 20_000) { onAllNodes(u2InCard(ada.ref, PeopleStrings.WAVED)).fetchSemanticsNodes().isNotEmpty() }
        val wave = rig.server.requests("POST", "/api/meet").single { it.body!!["ref"]?.jsonPrimitive?.content == ada.ref }
        assertEquals(PeopleText.waveNote("Hallway"), wave.body!!["note"]?.jsonPrimitive?.content)
        assertEquals("I'm in Hallway too — want to talk shop?", wave.body!!["note"]?.jsonPrimitive?.content)
    }

    @Test
    fun watchingSomeoneWhoIsNotAroundTogglesWithTheWebsToasts() = runComposeUiTest {
        u2Ready(rig)
        val cy = rig.server.seedPerson(rig.slug, "Cy Seed", expertise = "Tuned eBPF probes.", speakTopics = listOf("ebpf"))
        u2Show(rig)
        u2WaitForTag("person-${cy.ref}")
        onNode(u2InCard(cy.ref, PeopleStrings.WATCH)).assertIsOff().performClick()
        waitUntil(timeoutMillis = 20_000) { PeopleStrings.watchOn("Cy Seed") in rig.toasts }
        assertEquals(
            "Watching Cy Seed. While you're around with the app open and nudges on, the People tab tells you when they're around.",
            rig.toasts.last(),
        )
        waitUntil(timeoutMillis = 20_000) { onAllNodes(u2InCard(cy.ref, PeopleStrings.WATCHING)).fetchSemanticsNodes().isNotEmpty() }
        onNode(u2InCard(cy.ref, PeopleStrings.WATCHING)).assertIsOn()
        assertEquals(listOf(cy.ref), rig.state.watch.map { it.ref })

        onNode(u2InCard(cy.ref, PeopleStrings.WATCHING)).performClick()
        waitUntil(timeoutMillis = 20_000) { "Stopped watching Cy Seed." in rig.toasts }
        waitUntil(timeoutMillis = 20_000) { onAllNodes(u2InCard(cy.ref, PeopleStrings.WATCH)).fetchSemanticsNodes().isNotEmpty() }
        assertTrue(rig.state.watch.isEmpty())
    }

    @Test
    fun blockFromTheMenuAsksFirstThenTheCardGoes() = runComposeUiTest {
        u2Ready(rig)
        val ada = rig.server.seedPerson(rig.slug, "Ada Seed", expertise = "Ran eBPF tracing.", speakTopics = listOf("ebpf"))
        val bo = rig.server.seedPerson(rig.slug, "Bo Seed", expertise = "Wrote eBPF maps.", speakTopics = listOf("ebpf"))
        u2Show(rig)
        u2WaitForTag("person-${ada.ref}")
        onNodeWithContentDescription(PeopleCommonStrings.optionsFor("Ada Seed")).performClick()
        u2WaitForTag("overflow-menu")
        onNode(hasText(PeopleCommonStrings.REPORT) and hasAnyAncestor(hasTestTag("overflow-menu"))).assertIsDisplayed()
        onNode(hasText(PeopleCommonStrings.BLOCK) and hasAnyAncestor(hasTestTag("overflow-menu"))).performClick()
        u2WaitForTag("block-confirm")
        onNodeWithText(PeopleCommonStrings.blockTitle("Ada Seed")).assertIsDisplayed()
        onNodeWithText(PeopleText.BLOCK_BODY).assertIsDisplayed()
        onNode(hasText(PeopleCommonStrings.BLOCK) and hasClickAction() and hasAnyAncestor(hasTestTag("block-confirm"))).performClick()

        u2WaitForNoTag("person-${ada.ref}")
        onNodeWithTag("person-${bo.ref}").assertExists()
        waitUntil(timeoutMillis = 20_000) { PeopleCommonStrings.blocked("Ada Seed") in rig.toasts }
        assertEquals(listOf(ada.ref), rig.state.blocks.map { it.ref })
        assertEquals(listOf(ada.ref), rig.server.blockedBy(rig.me))
    }

    @Test
    fun theCardShowsTopicsContactAndTheBroadAndSampleVariants() = runComposeUiTest {
        u2Ready(rig)
        val full = "b000000000000001"
        val other = "b000000000000002"
        val broad = "b000000000000003"
        val labels = listOf("eBPF", "Kubernetes", "Security", "Postgres", "Kafka", "WebAssembly", "Rust", "Go")
        rig.matches = {
            u2CraftedPage(
                buildJsonObject {
                    put("ref", full)
                    put("display_name", "Sample · Avery")
                    put("about", "Placeholder profile 1 for local development.")
                    put("sample", true)
                    put("learn_topics", JsonArray(listOf(buildJsonObject { put("topic_id", "ebpf"); put("label", "eBPF") })))
                    put("speak_topics", JsonArray(labels.map { l -> buildJsonObject { put("topic_id", l.lowercase()); put("label", l) } }))
                    put("reasons", JsonArray(listOf(JsonPrimitive("They can speak to Security, which you want to learn about."), JsonPrimitive("You are both interested in <mark>Intro</mark> to eBPF tracing."))))
                    put("opener", "They can speak to Security, which you want to learn about.")
                    put("contact", buildJsonObject { put("linkedin_url", "https://www.linkedin.com/in/sample-avery"); put("contact_note", "@avery on the CNCF Slack") })
                    put("evidence", "Ran Postgres operators on bare metal; broke and fixed <mark>Kubernetes</mark> upgrades.")
                    put("around", false)
                    put("broad", false)
                },
                u2CraftedPerson(other, "Blake Elsewhere", linkedin = "https://evil.example/in/blake", note = "Find me at the booth"),
                buildJsonObject {
                    put("ref", broad)
                    put("display_name", "Sawyer Broad")
                    put("about", "Placeholder profile 9 for local development.")
                    put("reasons", JsonArray(listOf(JsonPrimitive("Also interested in <mark>Kubernetes</mark>."), JsonPrimitive("They're new here."))))
                    put("evidence", "Never shown on a broad card.")
                    put("broad", true)
                },
            )
        }
        u2Show(rig)
        u2WaitForTag("person-$full")
        onNodeWithText(PeopleCommonStrings.SAMPLE_NOTE).assertIsDisplayed()
        onNode(u2InCard(full, "Ran Postgres operators on bare metal; broke and fixed Kubernetes upgrades.")).assertIsDisplayed()
        // The opener in its box, the other reason in the list, never twice.
        onAllNodes(u2InCard(full, "They can speak to Security, which you want to learn about.")).assertCountEquals(1)
        onNode(u2InCard(full, "You are both interested in Intro to eBPF tracing.")).assertExists()
        onNode(u2InCard(full, "Can speak to: eBPF, Kubernetes, Security, Postgres, Kafka, WebAssembly and 2 more")).assertExists()
        onNode(u2InCard(full, "Wants to learn: eBPF")).assertExists()
        onNode(u2InCard(full, PeopleStrings.HOW_TO_REACH_ME.uppercase())).assertExists()
        onNode(u2InCard(full, "@avery on the CNCF Slack")).assertExists()
        u2ScrollToCard(full)
        onNodeWithTag("people-screen").performScrollToNode(u2InCard(full, PeopleStrings.LINKEDIN_PROFILE))
        onNode(u2InCard(full, PeopleStrings.LINKEDIN_PROFILE)).performClick()
        runOnIdle { assertEquals(listOf("https://www.linkedin.com/in/sample-avery"), rig.opened.toList()) }

        // A link that is not LinkedIn is never offered; the note still is.
        u2ScrollToCard(other)
        onNode(u2InCard(other, "Find me at the booth")).assertExists()
        onAllNodes(u2InCard(other, PeopleStrings.LINKEDIN_PROFILE)).assertCountEquals(0)

        // A broad match: its "Also interested in" line, no evidence, and the line not repeated in the reasons.
        u2ScrollToCard(broad)
        onAllNodes(u2InCard(broad, "Also interested in Kubernetes.")).assertCountEquals(1)
        onNode(u2InCard(broad, "They're new here.")).assertExists()
        onAllNodes(u2InCard(broad, "Never shown on a broad card.")).assertCountEquals(0)
    }

    @Test
    fun onlyHttpsLinkedInLinksAreOpened() {
        assertTrue(isLinkedInUrl("https://www.linkedin.com/in/your-name"))
        assertTrue(isLinkedInUrl("https://linkedin.com/in/your-name"))
        assertTrue(isLinkedInUrl("HTTPS://uk.LinkedIn.com/in/x"))
        assertFalse(isLinkedInUrl("http://www.linkedin.com/in/your-name"))
        assertFalse(isLinkedInUrl("https://www.linkedin.com.evil.example/in/x"))
        assertFalse(isLinkedInUrl("https://evil.example/www.linkedin.com/in/x"))
        assertFalse(isLinkedInUrl("https://www.linkedin.com@evil.example/in/x"))
        assertFalse(isLinkedInUrl("https://notlinkedin.com/in/x"))
        assertFalse(isLinkedInUrl("javascript:alert(1)"))
    }
}
