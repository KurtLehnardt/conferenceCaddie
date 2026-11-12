package app.conferencecaddie.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalAccessibilityManager
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.v2.runComposeUiTest
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import app.conferencecaddie.ui.components.CaddieChip
import app.conferencecaddie.ui.components.CardLink
import app.conferencecaddie.ui.components.ChipRow
import app.conferencecaddie.ui.components.ConfirmDialogCard
import app.conferencecaddie.ui.components.LocalWideLayout
import app.conferencecaddie.ui.components.TalkCard
import app.conferencecaddie.ui.components.Toast
import app.conferencecaddie.ui.components.ToastData
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.shell.ConnectDetails
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.CaddieTheme
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// The design system's components where they carry behaviour of their own: run on the iOS simulator
// and on an Android device or emulator, as ShellUiTest is.
@OptIn(ExperimentalTestApi::class)
class ComponentsUiTest {
    @Test
    fun theServerQuestionKeepsItsButtonsAtTheLargestTextSize() = runComposeUiTest {
        var answer: String? = null
        // The dialog's room on a phone in landscape, at the largest accessibility text size.
        setContent {
            TestDevice(DpSize(400.dp, 340.dp), fontScale = 2.5f) {
                CaddieTheme {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        ConfirmDialogCard(
                            title = Strings.Connect.TITLE,
                            body = null,
                            confirmLabel = Strings.Connect.SWITCH,
                            onConfirm = { answer = "switch" },
                            onDismiss = { answer = "cancel" },
                            destructive = false,
                        ) {
                            ConnectDetails("https://caddie.example.net/a/long/path/for/a/tier-1/site", official = false)
                        }
                    }
                }
            }
        }

        onNodeWithText(Strings.Common.CANCEL).assertIsDisplayed()
        onNodeWithText(Strings.Connect.SWITCH).assertIsDisplayed()
        // The question scrolls to its last line while the buttons stay put.
        onNodeWithText(Strings.Connect.KEPT).performScrollTo().assertIsDisplayed()
        onNodeWithText(Strings.Connect.SWITCH).assertIsDisplayed().performClick()
        waitForIdle()
        assertEquals("switch", answer)
    }

    @Test
    fun aTalkCardShowsOnlyWebLinksAndItsInterestToggle() = runComposeUiTest {
        val opened = mutableListOf<String>()
        var interested by mutableStateOf(false)
        setContent {
            CaddieTheme {
                TalkCard(
                    title = "Securing the supply chain",
                    whenText = "Tue, Nov 10 · 9:00–9:30 AM CST",
                    interested = interested,
                    onToggleInterested = { interested = !interested },
                    links = listOf(
                        CardLink(Strings.Talk.SLIDES, LucideIcon.Presentation, "https://example.org/slides.pdf"),
                        CardLink("Script", LucideIcon.Link, "javascript:alert(1)"),
                        CardLink("Phone", LucideIcon.Link, "tel:+15550100"),
                    ),
                    onOpenLink = { opened += it },
                )
            }
        }

        onNodeWithText("Script").assertDoesNotExist()
        onNodeWithText("Phone").assertDoesNotExist()
        onNodeWithText(Strings.Talk.SLIDES).performClick()
        assertEquals(listOf("https://example.org/slides.pdf"), opened)

        // "I'm interested" is a toggle that screen readers hear as on or off.
        onNodeWithText(Strings.Talk.INTERESTED).assertIsOff().performClick()
        onNodeWithText(Strings.Talk.INTERESTED).assertIsOn()
    }

    @Test
    fun chipRowsScrollOnPhonesAndWrapInTheWideLayout() = runComposeUiTest {
        var wide by mutableStateOf(false)
        setContent {
            CaddieTheme {
                CompositionLocalProvider(LocalWideLayout provides wide) {
                    Box(Modifier.width(320.dp)) {
                        ChipRow { repeat(6) { CaddieChip("Chip $it", active = false, onClick = {}) } }
                    }
                }
            }
        }

        // On a phone the row is one line that scrolls sideways.
        val first = onNodeWithText("Chip 0").getUnclippedBoundsInRoot()
        assertEquals(first.top, onNodeWithText("Chip 5").getUnclippedBoundsInRoot().top)
        // In the wide layout the chips wrap onto more lines, as on the web.
        wide = true
        waitForIdle()
        assertTrue(onNodeWithText("Chip 5").getUnclippedBoundsInRoot().top > onNodeWithText("Chip 0").getUnclippedBoundsInRoot().top)
    }

    @Test
    fun aToastDismissesThroughTheLatestCallback() = runComposeUiTest {
        val dismissedBy = mutableListOf<String>()
        var owner by mutableStateOf("first")
        // The device's accessibility settings may ask for longer than the web's five seconds.
        var timeout = 5_000L
        mainClock.autoAdvance = false
        setContent {
            val current = owner
            timeout = LocalAccessibilityManager.current?.calculateRecommendedTimeoutMillis(5_000, containsText = true) ?: 5_000L
            CaddieTheme { Toast(ToastData(1, "Saved"), onDismiss = { dismissedBy += current }, onAction = {}) }
        }
        mainClock.advanceTimeBy(1_000)
        onNodeWithText("Saved").assertIsDisplayed()

        // The caller recomposes with a new callback while the toast is showing.
        owner = "second"
        mainClock.advanceTimeBy(timeout)
        assertEquals(listOf("second"), dismissedBy)
        assertTrue(dismissedBy.none { it == "first" })
    }
}
