package app.conferencecaddie.ui.people

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.click
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performTouchInput
import app.conferencecaddie.ui.components.DEMO_NOTE_TAG
import app.conferencecaddie.ui.components.DEMO_PILL_TAG
import app.conferencecaddie.ui.strings.Strings
import kotlinx.coroutines.delay

// The parity screenshots of the "Demo" label: each screen where a demo conference's data shows, with
// the summit published as a demo conference (ParityRig's demo), as the web's mock shows its demo
// conference (web/src/mock/fixtures.ts, "Caddie Demo Conference"). The pill sits in the app bar,
// in the switcher, at the top of each full talk card and in the talk sheet; the note sits at the top
// of every screen of the conference and of the Import my schedule sheet. File names start with
// demo-; the windows are a phone's, 390 x 844 and 320 x 700, light and dark.

/** The demo conference's name, as the web mock names it. */
internal const val DEMO_CONFERENCE_NAME = "Caddie Demo Conference"

/** A node whose test tag starts with [prefix]. */
private fun tagStarts(prefix: String) = SemanticsMatcher("test tag starting with $prefix") {
    it.config.getOrNull(SemanticsProperties.TestTag)?.startsWith(prefix) == true
}

/** Waits for [matcher] in the unmerged tree: a talk card is one button, so its parts are only there. */
@OptIn(ExperimentalTestApi::class)
private fun ParityRun.waitUnmerged(matcher: SemanticsMatcher) {
    waitUntil(timeoutMillis = 20_000) { onAllNodes(matcher, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
}

/** The Search tab with its first talk cards and their pills. */
@OptIn(ExperimentalTestApi::class)
private fun ParityRun.searchTab() {
    start(tab = "tab-Search")
    waitFor(hasTestTag(DEMO_NOTE_TAG))
    waitUnmerged(hasTestTag(DEMO_PILL_TAG) and hasAnyAncestor(hasTestTag("search-results")))
}

@OptIn(ExperimentalTestApi::class)
internal val DEMO_PARITY_STATES: List<ParityState> = listOf(
    ParityState("demo-switcher", 844, 700, demo = true) {
        searchTab()
        tap(hasTestTag("conference-switcher"), scroll = false)
        waitFor(hasTestTag("switcher-sheet"))
        pause(600)
        shoot()
    },
    ParityState("demo-search", 844, 700, demo = true) {
        searchTab()
        pause(600)
        shoot()
    },
    ParityState("demo-schedule", 844, 700, demo = true) {
        searchTab()
        tap(hasText(Strings.Search.VIEW_SCHEDULE) and hasClickAction(), scroll = false)
        waitFor(hasTestTag("schedule-screen"))
        waitUnmerged(tagStarts("sched-${ParitySample.SLUG}"))
        pause(600)
        shoot()
    },
    ParityState("demo-talk", 844, 700, demo = true) {
        searchTab()
        // A tap near the card's top left lands on the card itself (its pill and title), not on a button.
        onAllNodes(tagStarts("talk-${ParitySample.SLUG}")).onFirst().performTouchInput { click(Offset(48f, 48f)) }
        waitFor(hasTestTag("talk-sheet"))
        pause(800)
        shoot()
    },
    ParityState("demo-interested", 844, 700, demo = true) {
        start(interested = listOf(1, 3), tab = "tab-Interested")
        waitFor(hasTestTag("interested-screen"))
        waitFor(hasTestTag(DEMO_NOTE_TAG))
        pause(600)
        shoot()
    },
    ParityState("demo-for-you", 844, 700, demo = true) {
        start(tab = "tab-For you", prepare = {
            rig.core.setLearnTopics(JORDAN_LEARNS)
            while (rig.core.state.value.learn.topics != JORDAN_LEARNS) delay(20)
        })
        waitFor(hasTestTag(DEMO_NOTE_TAG))
        waitUnmerged(tagStarts("for-you-${ParitySample.SLUG}"))
        runCatching { onNodeWithTag("for-you-screen").performScrollToIndex(0) }
        pause(800)
        shoot()
    },
    ParityState("demo-people", 844, 700, demo = true) {
        start()
        settleCards()
        peopleTop()
        waitFor(hasTestTag(DEMO_NOTE_TAG))
        pause(400)
        shoot()
    },
    ParityState("demo-around", 844, 700, demo = true) {
        aroundIn("Expo hall", spot = "by the coffee cart")
        peopleTop()
        waitFor(hasTestTag(DEMO_NOTE_TAG))
        shoot()
    },
    ParityState("demo-profile", 844, 700, demo = true) {
        start(tab = null)
        openProfile()
        waitSuggested()
        waitFor(hasTestTag(DEMO_NOTE_TAG))
        // The profile scrolls as one column: back to its top, where the note is.
        runCatching { onAllNodes(hasTestTag(DEMO_NOTE_TAG)).onFirst().performScrollTo() }
        pause(600)
        shoot()
    },
    ParityState("demo-inbox", 844, 700, demo = true) {
        inboxWithBlake("Hallway", devon = true)
        waitFor(hasTestTag(DEMO_NOTE_TAG))
        shoot()
    },
    ParityState("demo-meet", 844, 700, demo = true) {
        meetActive(sameZone = false)
        waitFor(hasTestTag(DEMO_NOTE_TAG))
        shoot()
    },
    ParityState("demo-import", 844, 700, demo = true) {
        start(tab = "tab-Search")
        openSettings()
        tap(hasText(Strings.Settings.IMPORT) and hasClickAction())
        waitFor(hasTestTag("import-sheet"))
        waitFor(hasTestTag(DEMO_NOTE_TAG) and hasAnyAncestor(hasTestTag("import-sheet")))
        pause(600)
        shoot()
    },
)
