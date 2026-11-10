package app.conferencecaddie.ui

import androidx.compose.ui.graphics.vector.PathNode
import androidx.compose.ui.graphics.vector.VectorPath
import app.conferencecaddie.ui.format.Format
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.icons.vector
import app.conferencecaddie.ui.shell.isWebLink
import app.conferencecaddie.ui.strings.Strings
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

// The web's formatting (web/src/lib/time.ts and web/src/components/search.tsx), with the values the
// web prints for the same inputs.
class FormatTest {
    @Test
    fun daysAndRangesReadAsOnTheWeb() {
        assertEquals("Tue, Nov 10", Format.day("2026-11-10"))
        assertEquals("Tuesday, November 10", Format.dayLong("2026-11-10"))
        assertEquals("Mon, Mar 2", Format.day("2099-03-02"))
        assertEquals("Nov 9–12, 2026", Format.dateRange("2026-11-09", "2026-11-12"))
        assertEquals("Nov 30 – Dec 2, 2026", Format.dateRange("2026-11-30", "2026-12-02"))
        assertEquals("Jan 20, 2027", Format.dateRange("2027-01-20", "2027-01-20"))
    }

    @Test
    fun timesReadAsOnTheWeb() {
        assertEquals("9:00–9:30 AM", Format.timeRange(540, 570))
        assertEquals("11:30 AM–12:15 PM", Format.timeRange(690, 735))
        assertEquals("12:00 AM", Format.time(0))
        assertEquals("Tue, Nov 10 · 9:00–9:30 AM CST", Format.`when`("2026-11-10", 540, 570, "CST"))
        assertEquals("12 PM", Format.hour(12))
        assertEquals("Level 1 · Hall DE", Format.room("Salt Palace | Level 1 | Hall DE"))
    }

    @Test
    fun countsAndLabelsReadAsOnTheWeb() {
        assertEquals("1 talk", Strings.Search.count(1, browse = false, includeEvents = false))
        assertEquals("All talks · 12", Strings.Search.count(12, browse = true, includeEvents = false))
        assertEquals("Everything · 3 results", Strings.Search.count(3, browse = true, includeEvents = true))
        assertEquals("Track · 2", Strings.Chips.group("Track", listOf("A", "B")))
        assertEquals("Security", Strings.Chips.group("Track", listOf("Security")))
        assertEquals("Show 1 talk", Strings.FilterSheet.show(1, includeEvents = false))
        assertEquals("Tuesday · Tue, Nov 10", Strings.Chips.timePhrase("Tuesday", Format.day("2026-11-10")))
        assertEquals("Switch to the server at https://kurtlehnardt.github.io/conferenceCaddie?", Strings.Connect.prompt("https://kurtlehnardt.github.io/conferenceCaddie"))
    }

    @Test
    fun storageSizesRoundAndChangeUnitAtTheRightPlace() {
        assertEquals("999 bytes", Strings.Settings.bytes(999))
        assertEquals("1 KB", Strings.Settings.bytes(1_000))
        assertEquals("999 KB", Strings.Settings.bytes(999_499))
        assertEquals("1.0 MB", Strings.Settings.bytes(999_500))
        assertEquals("1.0 MB", Strings.Settings.bytes(1_049_999))
        assertEquals("1.1 MB", Strings.Settings.bytes(1_050_000))
        assertEquals("1.5 MB", Strings.Settings.bytes(1_482_323))
        assertEquals("10.0 MB", Strings.Settings.bytes(9_999_999))
    }

    @Test
    fun onlyHttpLinksAreOpened() {
        assertTrue(isWebLink("https://example.org/"))
        assertTrue(isWebLink("Https://example.org/"))
        assertTrue(isWebLink("http://example.org/"))
        assertFalse(isWebLink("javascript:alert(1)"))
        assertFalse(isWebLink("caddie://connect?url=https://x"))
        assertFalse(isWebLink("file:///etc/passwd"))
    }

    @Test
    fun everyIconParsesIntoOneStrokeAPath() {
        for (icon in LucideIcon.entries) {
            assertTrue(icon.paths.isNotEmpty(), icon.name)
            val v = icon.vector(strokeWidth = 1.75f)
            // One drawn path per SVG path, each starting with a move, stroked at the width asked for.
            assertEquals(icon.paths.size, v.root.size, icon.name)
            for (i in 0 until v.root.size) {
                val path = v.root[i] as VectorPath
                assertTrue(path.pathData.isNotEmpty(), "${icon.name} path $i is empty")
                val first = path.pathData.first()
                assertTrue(first is PathNode.MoveTo || first is PathNode.RelativeMoveTo, "${icon.name} path $i starts with $first")
                assertEquals(1.75f, path.strokeLineWidth, icon.name)
                assertNull(path.fill, icon.name)
            }
            // The filled variant (the star of a talk marked Interested) fills every path.
            val filled = icon.vector(filled = true)
            for (i in 0 until filled.root.size) assertNotNull((filled.root[i] as VectorPath).fill, icon.name)
        }
    }
}
