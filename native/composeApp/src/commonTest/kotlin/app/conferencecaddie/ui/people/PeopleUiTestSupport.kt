package app.conferencecaddie.ui.people

import androidx.compose.runtime.Composable
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.shared.InMemorySecureStore
import app.conferencecaddie.shared.PeopleServices
import app.conferencecaddie.shared.net.ApiHttp
import app.conferencecaddie.shared.net.HttpResponse
import app.conferencecaddie.shared.people.ConferenceInfo
import app.conferencecaddie.shared.people.PeopleAvailability
import app.conferencecaddie.shared.people.PeopleContext
import app.conferencecaddie.shared.people.PeopleController
import app.conferencecaddie.shared.people.PeopleFeatures
import app.conferencecaddie.shared.people.PeopleKeyValue
import app.conferencecaddie.shared.people.PeopleUiState
import app.conferencecaddie.ui.TestDevice
import kotlinx.coroutines.CoroutineScope

// Small stand-ins for the people UI tests: the phone they draw on, typing without the keyboard, a
// controller built with its constructor over a map and an API that answers the few routes the shell
// touches with empty results.

/** The phone the people UI tests draw on: 390 by 844 dp, the screen of an iPhone 14. */
val TEST_PHONE = DpSize(390.dp, 844.dp)

/**
 * Draws [content] as [TEST_PHONE] at [fontScale] (see [TestDevice]), so a people UI test sees the
 * same screen on every emulator and simulator, CI's small emulator included, whatever their own
 * screen size, system bars and font size.
 */
@Composable
fun TestPhone(fontScale: Float = 1f, content: @Composable () -> Unit) = TestDevice(TEST_PHONE, fontScale, content)

/**
 * Puts [text] in this field as typing would, without focusing it: a focused field brings up the
 * software keyboard on an emulator, which covers much of a small screen while it animates and makes
 * the test depend on the keyboard. The keyboard itself is checked on devices.
 */
fun SemanticsNodeInteraction.typeText(text: String): SemanticsNodeInteraction =
    performSemanticsAction(SemanticsActions.SetText) { it(AnnotatedString(text)) }

/** People records in memory. */
class MemoryKeyValue : PeopleKeyValue {
    private val values = HashMap<String, String>()

    override suspend fun get(key: String): String? = values[key]

    override suspend fun set(key: String, value: String?) {
        if (value == null) values.remove(key) else values[key] = value
    }
}

/** An empty inbox, no matches, and 404 for everything else. */
val emptyPeopleApi = ApiHttp { _, url, _, _, _, _ ->
    val path = url.substringAfter("://").substringAfter('/').substringBefore('?')
    when (path) {
        "api/meet/inbox" -> json(200, """{"incoming":[],"outgoing":[]}""")
        "api/people/matches" -> json(200, """{"results":[],"from":0,"size":20,"has_more":false}""")
        else -> json(404, """{"error":"Not found"}""")
    }
}

private fun json(status: Int, body: String) =
    HttpResponse(status, body.encodeToByteArray(), headers = mapOf("content-type" to "application/json"))

const val TEST_BASE = "https://caddie.test"

/** A controller for [scope], with no context until [peopleContext] is given to it. */
fun testController(scope: CoroutineScope, http: ApiHttp = emptyPeopleApi): PeopleController =
    PeopleController(MemoryKeyValue(), http, PeopleServices(secureStore = InMemorySecureStore()), scope, allowLocalHttp = false)

/** Every people feature on (Bluetooth and push aside), at one conference without a bundle. */
fun peopleContext(): PeopleContext = PeopleContext(
    backend = BackendUrl.normalise(TEST_BASE) as BackendUrl.Valid,
    capabilities = Capabilities(
        people = Capabilities.People(enabled = true, presence = true, gpsBands = true, meets = true, circles = true, reports = true),
    ),
    conference = ConferenceInfo("sample-cloud-summit-2026", "Sample Cloud Summit"),
    bundle = null,
)

/** A ready state, as the controller publishes one for [peopleContext], for screens drawn without it. */
fun readyState(inboxCount: Int = 0): PeopleUiState = PeopleUiState(
    availability = PeopleAvailability.Ready,
    backend = TEST_BASE,
    conference = ConferenceInfo("sample-cloud-summit-2026", "Sample Cloud Summit"),
    features = PeopleFeatures(enabled = true, presence = true, gpsBands = true, meets = true, circles = true, reports = true),
    inbox = app.conferencecaddie.shared.people.InboxView(loaded = true, count = inboxCount),
)
