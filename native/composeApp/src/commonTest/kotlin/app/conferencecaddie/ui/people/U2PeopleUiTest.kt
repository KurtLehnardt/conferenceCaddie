package app.conferencecaddie.ui.people

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.runComposeUiTest
import androidx.compose.ui.unit.dp
import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.shared.InMemorySecureStore
import app.conferencecaddie.shared.PeopleServices
import app.conferencecaddie.shared.net.ApiHttp
import app.conferencecaddie.shared.net.HttpResponse
import app.conferencecaddie.shared.people.ConferenceInfo
import app.conferencecaddie.shared.people.PeopleContext
import app.conferencecaddie.shared.people.PeopleController
import app.conferencecaddie.shared.people.PeopleUiState
import app.conferencecaddie.shared.people.TopicRef
import app.conferencecaddie.ui.shell.ShellNavigation
import app.conferencecaddie.ui.theme.Caddie
import app.conferencecaddie.ui.theme.CaddieTheme
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.datetime.TimeZone
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

// U2's screens (the People home, PersonCard, ReportSheet) against the real PeopleController over
// FakePeopleServer: the rig the U2 tests share, then the privacy rules of the cards, "See who" and
// the screens at twice the font size. Run on the iOS simulator and on Android.

/** The people features as FakePeopleServer offers them (tier 3 minus Bluetooth). */
internal val U2_PEOPLE_ON = Capabilities(
    people = Capabilities.People(
        enabled = true,
        semantic = Capabilities.Semantic.Server,
        presence = true,
        gpsBands = true,
        meets = true,
        circles = true,
        reports = true,
    ),
)

/**
 * A real controller over FakePeopleServer at the Alpha conference, the shell navigation, and the
 * toasts and links the screens produced. [matches] answers `POST /api/people/matches` with a crafted
 * page instead of the server (still recorded in `server.requests`), for answers the fake would never
 * give, such as a zone while I am not around.
 */
internal class U2Rig {
    val slug = "alpha-conf-2099"
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val clock = TestClock()
    val server = FakePeopleServer({ clock.ms }, FakeConference.alpha())
    var matches: (() -> String)? = null
    private val http = ApiHttp { method, url, headers, body, timeoutMs, maxBytes ->
        val crafted = matches
        if (crafted != null && method == "POST" && url.substringBefore('?').endsWith("/api/people/matches")) {
            server.requests += RecordedRequest(method, url, headers, body?.decodeToString())
            HttpResponse(200, crafted().encodeToByteArray(), headers = mapOf("content-type" to "application/json"))
        } else {
            server.send(method, url, headers, body, timeoutMs, maxBytes)
        }
    }
    val controller = PeopleController(InMemoryPeopleKeyValue(), http, PeopleServices(InMemorySecureStore()), scope, allowLocalHttp = false, clock = clock, timeZone = TimeZone.UTC)
    val nav = ShellNavigation()
    val toasts = mutableStateListOf<String>()
    val opened = mutableStateListOf<String>()
    var talks = PeopleTalks(bundle = null, interested = emptyList(), nowMs = TestClock.START_MS)
    lateinit var host: PeopleHost

    val state: PeopleUiState get() = controller.state.value
    val me: FakePerson get() = server.me(slug) ?: error("No profile on the server")

    fun close() {
        controller.close()
        scope.cancel()
    }
}

/** Runs [block] on the rig's scope and waits for it. */
@OptIn(ExperimentalTestApi::class, ExperimentalCoroutinesApi::class)
internal fun <T> ComposeUiTest.u2Await(rig: U2Rig, block: suspend () -> T): T {
    val done = rig.scope.async { block() }
    waitUntil(timeoutMillis = 20_000) { done.isCompleted }
    return done.getCompleted()
}

/**
 * The Alpha conference with people features on; a profile named [name] wanting to learn eBPF (none
 * with null), visible conference-wide when [visible], and around in [zone] when it is set.
 */
@OptIn(ExperimentalTestApi::class)
internal fun ComposeUiTest.u2Ready(rig: U2Rig, name: String? = "Me Myself", visible: Boolean = true, zone: String? = null) {
    u2Await(rig) {
        rig.controller.updateContext(PeopleContext(testBackendUrl(), U2_PEOPLE_ON.forThisApp(), ConferenceInfo(rig.slug, "Alpha Conference", "UTC"), bundle = null))
        if (name != null) {
            rig.controller.updateProfile { it.copy(displayName = name, about = "Tester.", interests = "tracing") }
            rig.controller.setTopics(learn = listOf(TopicRef("ebpf", "eBPF")), speak = emptyList())
        }
        if (visible) assertNull(rig.controller.setOpenToMeet(true))
        if (zone != null) assertNull(rig.controller.turnOnPresence(zone, ""))
    }
}

/**
 * The People tab as PeopleTab draws it online, with the shared sheets, in the light theme, on the
 * test phone. [state] may change what the screen is given (a reveal); [fontScale] scales the text.
 */
@OptIn(ExperimentalTestApi::class)
internal fun ComposeUiTest.u2Show(rig: U2Rig, fontScale: Float = 1f, state: (PeopleUiState) -> PeopleUiState = { it }) {
    setContent {
        val scope = rememberCoroutineScope()
        val host = remember {
            PeopleHost(rig.controller, rig.nav, scope, { message, _ -> rig.toasts += message }, {}, { rig.opened += it }).also { rig.host = it }
        }
        val current by rig.controller.state.collectAsState()
        TestPhone(fontScale) {
            CaddieTheme {
                Box(Modifier.fillMaxSize().background(Caddie.colors.bg)) {
                    PeopleTab(state(current), host, rig.talks, online = true)
                    PeopleSheets(current, host)
                }
            }
        }
    }
}

@OptIn(ExperimentalTestApi::class)
internal fun ComposeUiTest.u2WaitForText(text: String, substring: Boolean = false) {
    waitUntil(timeoutMillis = 20_000) { onAllNodesWithText(text, substring).fetchSemanticsNodes().isNotEmpty() }
}

@OptIn(ExperimentalTestApi::class)
internal fun ComposeUiTest.u2WaitForTag(tag: String) {
    waitUntil(timeoutMillis = 20_000) { onAllNodes(hasTestTag(tag)).fetchSemanticsNodes().isNotEmpty() }
}

@OptIn(ExperimentalTestApi::class)
internal fun ComposeUiTest.u2WaitForNoTag(tag: String) {
    waitUntil(timeoutMillis = 20_000) { onAllNodes(hasTestTag(tag)).fetchSemanticsNodes().isEmpty() }
}

/** Scrolls the People home until [ref]'s card is composed. */
@OptIn(ExperimentalTestApi::class)
internal fun ComposeUiTest.u2ScrollToCard(ref: String) {
    onNodeWithTag("people-screen").performScrollToNode(hasTestTag("person-$ref"))
}

/** A node with [text] inside [ref]'s card. */
internal fun u2InCard(ref: String, text: String, substring: Boolean = false) = hasText(text, substring) and hasAnyAncestor(hasTestTag("person-$ref"))

/** Any node whose text matches [regex]. */
internal fun u2TextMatching(regex: Regex) = SemanticsMatcher("text matches $regex") { node ->
    node.config.getOrNull(SemanticsProperties.Text)?.any { regex.containsMatchIn(it.text) } == true ||
        node.config.getOrNull(SemanticsProperties.EditableText)?.let { regex.containsMatchIn(it.text) } == true
}

/** One result of a crafted matches page, with any [extra] fields the server should never send. */
internal fun u2CraftedPerson(
    ref: String,
    name: String,
    around: Boolean = false,
    zone: String? = null,
    proximity: String? = null,
    sample: Boolean = false,
    evidence: String? = null,
    about: String = "Placeholder profile for local development.",
    linkedin: String? = null,
    note: String? = null,
    extra: Map<String, JsonPrimitive> = emptyMap(),
): JsonObject = buildJsonObject {
    put("ref", ref)
    put("display_name", name)
    put("about", about)
    put("sample", sample)
    put("learn_topics", JsonArray(listOf(buildJsonObject { put("topic_id", "ebpf"); put("label", "eBPF") })))
    put("speak_topics", JsonArray(listOf(buildJsonObject { put("topic_id", "kubernetes"); put("label", "Kubernetes") })))
    put("reasons", JsonArray(listOf(JsonPrimitive("They can speak to Kubernetes, which you want to learn about."))))
    put("opener", JsonNull)
    putJsonObject("contact") {
        put("linkedin_url", linkedin)
        put("contact_note", note)
    }
    put("evidence", evidence)
    put("around", around)
    put("zone", zone)
    put("proximity", proximity)
    put("broad", false)
    extra.forEach { (k, v) -> put(k, v) }
}

/** A crafted matches page of [people], the last one. */
internal fun u2CraftedPage(vararg people: JsonObject): String = buildJsonObject {
    put("results", JsonArray(people.toList()))
    put("from", 0)
    put("size", 20)
    put("has_more", false)
}.toString()

/** Fields a matches answer must never carry to a card: a spot line, a how-to-spot-me line, a distance and a bearing. */
private val FORBIDDEN = mapOf(
    "spot" to JsonPrimitive("by the coffee cart"),
    "spot_me" to JsonPrimitive("green hoodie"),
    "distance_m" to JsonPrimitive(42),
    "bearing_deg" to JsonPrimitive(90),
)

/** Text that would be a distance, a bearing or a spot line. */
private val DISTANCE_OR_SPOT = Regex("""\b\d+\s?(m|km|metres|meters|ft|feet)\b|\bmetres\b|\bmeters\b|\baway\b|degrees|coffee cart|green hoodie""", RegexOption.IGNORE_CASE)

@OptIn(ExperimentalTestApi::class)
class U2PeopleUiTest {
    private val rig = U2Rig()

    @AfterTest
    fun cleanUp() = rig.close()

    @Test
    fun withMyPresenceOffCardsShowNoZoneBandSpotOrDistanceWhateverTheServerSends() = runComposeUiTest {
        u2Ready(rig)
        val ref = "a000000000000001"
        rig.matches = { u2CraftedPage(u2CraftedPerson(ref, "Zoe Crafted", around = true, zone = "Hall A", proximity = "same_zone", extra = FORBIDDEN)) }
        u2Show(rig)
        u2WaitForTag("person-$ref")
        onNode(u2InCard(ref, PeopleCommonStrings.around(null))).assertIsDisplayed()
        onAllNodes(hasText("Hall A", substring = true)).assertCountEquals(0)
        onAllNodes(hasText(PeopleCommonStrings.BAND_SAME_ZONE)).assertCountEquals(0)
        onAllNodes(u2TextMatching(DISTANCE_OR_SPOT)).assertCountEquals(0)
        // Not in my zone, since I am not around: an ask, never a wave.
        onNode(u2InCard(ref, PeopleStrings.ASK_TO_TALK_SHOP)).assertIsDisplayed()
        onAllNodes(u2InCard(ref, PeopleStrings.WAVE)).assertCountEquals(0)
    }

    @Test
    fun withMyPresenceOnAZoneShowsOnlyForPeopleWhoAreAroundAndNeverADistance() = runComposeUiTest {
        u2Ready(rig, zone = "Hallway")
        val here = "a000000000000001"
        val gone = "a000000000000002"
        val venue = "a000000000000003"
        val near = "a000000000000004"
        rig.matches = {
            u2CraftedPage(
                u2CraftedPerson(here, "Ann Here", around = true, zone = "Hallway", proximity = "same_zone", extra = FORBIDDEN),
                u2CraftedPerson(gone, "Ben Gone", around = false, zone = "Hall B", proximity = "near", extra = FORBIDDEN),
                u2CraftedPerson(venue, "Cat Venue", around = true, zone = "Expo hall", proximity = "venue"),
                u2CraftedPerson(near, "Dan Near", around = true, zone = "Hall A", proximity = "near", extra = FORBIDDEN),
            )
        }
        u2Show(rig)
        u2WaitForTag("person-$here")
        onNodeWithText(PeopleStrings.AROUND_TITLE).assertIsDisplayed()
        onNodeWithText(PeopleStrings.inZone("Hallway").uppercase()).assertIsDisplayed()
        onNode(u2InCard(here, PeopleCommonStrings.around("Hallway"))).assertIsDisplayed()
        onNode(u2InCard(here, PeopleCommonStrings.BAND_SAME_ZONE)).assertIsDisplayed()
        onNode(u2InCard(here, PeopleStrings.WAVE)).assertIsDisplayed()

        // Someone not around: no Around line, no zone, no band, whatever the server sent.
        u2ScrollToCard(gone)
        onAllNodes(u2InCard(gone, "Around", substring = true)).assertCountEquals(0)
        onAllNodes(hasText("Hall B", substring = true)).assertCountEquals(0)
        onAllNodes(u2InCard(gone, PeopleCommonStrings.BAND_NEAR)).assertCountEquals(0)

        // The venue band says nothing; a near band is a word, never a number.
        u2ScrollToCard(venue)
        onNode(u2InCard(venue, PeopleCommonStrings.around("Expo hall"))).assertExists()
        onAllNodes(u2InCard(venue, PeopleCommonStrings.BAND_SAME_ZONE)).assertCountEquals(0)
        onAllNodes(u2InCard(venue, PeopleCommonStrings.BAND_NEAR)).assertCountEquals(0)
        onAllNodes(u2InCard(venue, PeopleCommonStrings.BAND_AROUND)).assertCountEquals(0)
        u2ScrollToCard(near)
        onNode(u2InCard(near, PeopleCommonStrings.around("Hall A"))).assertExists()
        onNode(u2InCard(near, PeopleCommonStrings.BAND_NEAR)).assertExists()
        onAllNodes(u2TextMatching(DISTANCE_OR_SPOT)).assertCountEquals(0)
    }

    @Test
    fun seeWhoScrollsToTheirCardInTheAroundView() = runComposeUiTest {
        u2Ready(rig, zone = "Hallway")
        val people = (1..12).map { i -> rig.server.seedPerson(rig.slug, "Person ${i.toString().padStart(2, '0')}", expertise = "Ran eBPF probes.", speakTopics = listOf("ebpf"), around = "Expo hall") }
        val last = people.last()
        var reveal by mutableStateOf<String?>(null)
        u2Show(rig) { if (reveal != null) it.copy(reveal = reveal) else it }
        u2WaitForTag("person-${people.first().ref}")
        onAllNodes(hasTestTag("person-${last.ref}")).assertCountEquals(0)
        reveal = last.ref
        u2WaitForTag("person-${last.ref}")
        waitUntil(timeoutMillis = 20_000) { runCatching { onNodeWithTag("person-${last.ref}").assertIsDisplayed() }.isSuccess }
    }

    @Test
    fun theHomeAndACardWorkAtTwiceTheFontSize() = runComposeUiTest {
        u2Ready(rig)
        val ref = "a000000000000001"
        rig.matches = {
            u2CraftedPage(
                u2CraftedPerson(
                    ref, "Sample · Maximilian Longname", around = true, sample = true,
                    evidence = "Ran <mark>Kubernetes</mark> upgrades across 60 clusters.",
                    linkedin = "https://www.linkedin.com/in/sample-max", note = "Sample profile, not a real person",
                ),
            )
        }
        u2Show(rig, fontScale = 2f)
        onNodeWithTag("people-search-field").assertIsDisplayed()
        onNodeWithTag("around-now-chip").assertIsDisplayed()
        onNodeWithTag("people-screen").performScrollToNode(hasText(PeopleStrings.PEOPLE_TO_MEET))
        onNodeWithText(PeopleStrings.PEOPLE_TO_MEET).assertIsDisplayed()
        u2WaitForTag("person-$ref")
        u2ScrollToCard(ref)
        onNode(u2InCard(ref, "Sample · Maximilian Longname")).assertIsDisplayed()

        // The header keeps the pill and the menu inside the card, and the name's words whole.
        val card = onNodeWithTag("person-$ref").getBoundsInRoot()
        val pill = onNode(hasContentDescription(PeopleCommonStrings.SAMPLE_SPOKEN) and hasAnyAncestor(hasTestTag("person-$ref"))).assertIsDisplayed().getBoundsInRoot()
        val menu = onNode(hasContentDescription(PeopleCommonStrings.optionsFor("Sample · Maximilian Longname"))).assertIsDisplayed().getBoundsInRoot()
        assertTrue(pill.right <= card.right && pill.left >= card.left, "pill $pill outside card $card")
        assertTrue(menu.right <= card.right + 0.5.dp, "menu $menu outside card $card")

        for (text in listOf(PeopleCommonStrings.around(null), PeopleStrings.HOW_TO_REACH_ME.uppercase(), PeopleStrings.LINKEDIN_PROFILE, PeopleStrings.ASK_TO_TALK_SHOP)) {
            onNodeWithTag("people-screen").performScrollToNode(u2InCard(ref, text))
            onNode(u2InCard(ref, text)).assertIsDisplayed()
        }
    }

    @Test
    fun theVisibilityPromptWorksAtTwiceTheFontSize() = runComposeUiTest {
        u2Ready(rig, visible = false)
        u2Show(rig, fontScale = 2f)
        u2WaitForText(PeopleStrings.VISIBILITY_TITLE)
        onNodeWithTag("people-screen").performScrollToNode(hasText(PeopleStrings.MAKE_VISIBLE))
        onNodeWithText(PeopleStrings.MAKE_VISIBLE).assertIsDisplayed()
    }
}
