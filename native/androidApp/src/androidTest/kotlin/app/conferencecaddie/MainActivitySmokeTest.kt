package app.conferencecaddie

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Starts the real app on a device or emulator and walks the shell: the tab bar is there, a tab can
 * be chosen, and Settings opens from the gear and closes with the app bar's Back and with the
 * system Back. Run it with `./gradlew :androidApp:connectedDebugAndroidTest`.
 */
@RunWith(AndroidJUnit4::class)
class MainActivitySmokeTest {
    @get:Rule
    val compose = createAndroidComposeRule<MainActivity>()

    @OptIn(ExperimentalTestApi::class)
    @Test
    fun theShellStartsAndNavigates() {
        // The app asks the real backend for its capabilities. The tab bar draws its tabs once it
        // knows whether People comes first, or after a wait; until it knows, a People tab could
        // still arrive and move the others, so the taps below wait for the tabs to be known.
        compose.waitUntilAtLeastOneExists(hasTestTag("tabs-known"), timeoutMillis = 60_000)
        compose.waitForIdle()
        compose.onNodeWithTag("tab-For you").assertIsDisplayed()
        compose.onNodeWithTag("tab-Search").assertIsDisplayed()
        compose.onNodeWithTag("tab-Interested").assertIsDisplayed()

        compose.onNodeWithTag("tab-Search").performClick()
        compose.onNodeWithTag("tab-Search").assertIsSelected()

        compose.onNodeWithContentDescription("Settings").performClick()
        compose.onNodeWithTag("settings-screen").assertIsDisplayed()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithTag("settings-screen").assertDoesNotExist()

        // The system Back (the gesture or the back button) leaves Settings too, and keeps the app open.
        compose.onNodeWithContentDescription("Settings").performClick()
        compose.onNodeWithTag("settings-screen").assertIsDisplayed()
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        compose.waitForIdle()
        compose.onNodeWithTag("settings-screen").assertDoesNotExist()
        compose.onNodeWithTag("tab-Search").assertIsSelected()
    }
}
