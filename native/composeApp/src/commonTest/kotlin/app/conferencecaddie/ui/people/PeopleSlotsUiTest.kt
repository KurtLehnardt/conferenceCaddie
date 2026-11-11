package app.conferencecaddie.ui.people

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.v2.runComposeUiTest
import app.conferencecaddie.shared.NotificationTaps
import app.conferencecaddie.ui.shell.rememberShellNavigation
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

// The slots the People layer hands the talk screens are the same lambdas on every recomposition,
// so a list holding them can skip.
@OptIn(ExperimentalTestApi::class)
class PeopleSlotsUiTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @AfterTest
    fun cleanUp() {
        scope.cancel()
        NotificationTaps.handled()
    }

    @Test
    fun talkControlsAndShareAllAreTheSameInstanceAcrossRecompositionsAndStateChanges() = runComposeUiTest {
        val controller = testController(scope)
        var interested by mutableStateOf(emptyList<String>())
        val seenControls = ArrayList<Any>()
        val seenShareAll = ArrayList<Any>()
        setContent {
            val ui = rememberPeopleUi(
                controller,
                rememberShellNavigation(),
                PeopleTalks(bundle = null, interested = interested, nowMs = 0),
                online = true,
                searchable = true,
                launch = null,
                showToast = { _, _, _ -> },
                openTalk = {},
                openUrl = {},
            )!!
            ui.talkControls?.let { seenControls += it }
            ui.shareAll?.let { seenShareAll += it }
        }
        scope.launch { controller.updateContext(peopleContext()) }
        waitUntil(timeoutMillis = 20_000) { seenControls.isNotEmpty() }
        // New inputs of every kind: the talks, then a state the controller publishes.
        interested = listOf("t1")
        waitForIdle()
        interested = listOf("t1", "t2")
        waitForIdle()

        assertTrue(seenControls.size >= 2, "composed ${seenControls.size} times")
        assertTrue(seenControls.all { it === seenControls.first() })
        assertTrue(seenShareAll.isNotEmpty() && seenShareAll.all { it === seenShareAll.first() })
    }
}
