package app.conferencecaddie

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Starts the real app on a device or emulator and walks the shell: the tab bar is there, a tab can
 * be chosen, and Settings opens from the gear and closes with Back. Run it with
 * `./gradlew :androidApp:connectedDebugAndroidTest`.
 */
@RunWith(AndroidJUnit4::class)
class MainActivitySmokeTest {
    @get:Rule
    val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun theShellStartsAndNavigates() {
        compose.onNodeWithTag("tab-For you").assertIsDisplayed()
        compose.onNodeWithTag("tab-Search").assertIsDisplayed()
        compose.onNodeWithTag("tab-Interested").assertIsDisplayed()

        compose.onNodeWithTag("tab-Search").performClick()
        compose.onNodeWithTag("tab-Search").assertIsSelected()

        compose.onNodeWithContentDescription("Settings").performClick()
        compose.onNodeWithTag("settings-screen").assertIsDisplayed()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithTag("settings-screen").assertDoesNotExist()
    }
}
