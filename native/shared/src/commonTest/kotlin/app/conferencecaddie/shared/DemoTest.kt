package app.conferencecaddie.shared

import kotlin.test.Test
import kotlin.test.assertEquals

// The words of the "Demo" label, which must match the web's (web/src/components/demo.ts), and the
// notification rule of docs/contracts/talk-bundle.md.
class DemoTest {
    @Test
    fun theWordsMatchTheWeb() {
        assertEquals("Demo", Demo.LABEL)
        assertEquals("Demo conference, invented data", Demo.SPOKEN)
        assertEquals("A demo conference with invented talks and speakers, not a real event.", Demo.NOTE)
    }

    @Test
    fun aDemoConferenceNameSaysDemo() {
        assertEquals("Caddie Demo Conference (Demo)", Demo.name("Caddie Demo Conference", demo = true))
        assertEquals("KubeCon", Demo.name("KubeCon", demo = false))
    }

    @Test
    fun aNotificationAboutADemoConferenceIsTitledAndPrefixedOneWay() {
        assertEquals("Conference Caddie (Demo)", Demo.notificationTitle("Conference Caddie", demo = true))
        assertEquals("Conference Caddie", Demo.notificationTitle("Conference Caddie", demo = false))
        assertEquals("Demo: Someone is near you", Demo.notificationBody("Someone is near you", demo = true))
        assertEquals("Someone is near you", Demo.notificationBody("Someone is near you", demo = false))
    }

    @Test
    fun aNotificationWithItsOwnTitleKeepsItInTheBody() {
        val title = "Conference Caddie is finding people near you"
        assertEquals(
            "Conference Caddie (Demo)" to "Demo: Conference Caddie is finding people near you. Your phone broadcasts a code.",
            Demo.notification("Conference Caddie", title, "Your phone broadcasts a code.", demo = true),
        )
        assertEquals(title to "Your phone broadcasts a code.", Demo.notification("Conference Caddie", title, "Your phone broadcasts a code.", demo = false))
    }
}
