package app.conferencecaddie.shared

import kotlin.test.Test
import kotlin.test.assertEquals

// The words of the "Demo" label, which must match the web's (web/src/components/demo.tsx).
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
    fun aNotificationTitleSaysDemoOnlyForADemoConference() {
        assertEquals("Conference Caddie · Demo conference", Demo.notificationTitle("Conference Caddie", demo = true))
        assertEquals("Conference Caddie", Demo.notificationTitle("Conference Caddie", demo = false))
    }
}
