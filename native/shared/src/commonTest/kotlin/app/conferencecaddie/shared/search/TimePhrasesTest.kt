package app.conferencecaddie.shared.search

import app.conferencecaddie.shared.search.TimePhrases.LunchWindow
import app.conferencecaddie.shared.search.TimePhrases.Shape
import kotlin.test.Test
import kotlin.test.assertEquals

// The phrase table of server/phrases.mjs, on a schedule shaped like KubeCon North America 2026:
// Monday 9 to Thursday 12 November, talks on every day, lunch from 12:30 to 13:45 on the three
// main days.
class TimePhrasesTest {
    private val kubecon = Shape(
        startDate = "2026-11-09",
        endDate = "2026-11-12",
        talkDays = listOf("2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"),
        lunch = mapOf(
            "2026-11-10" to LunchWindow(750, 825),
            "2026-11-11" to LunchWindow(750, 825),
            "2026-11-12" to LunchWindow(750, 825),
        ),
    )

    private fun keys(text: String, shape: Shape = kubecon) = TimePhrases.parse(text, shape).phrases.map { it.key }

    @Test
    fun tuesdayAfternoonLeavesTheText() {
        val r = TimePhrases.parse("kubernetes tuesday afternoon", kubecon)
        assertEquals("kubernetes", r.text)
        assertEquals(listOf("tuesday", "afternoon"), r.phrases.map { it.key })
        assertEquals(listOf("Tuesday", "Afternoon"), r.phrases.map { it.label })
        assertEquals(listOf("2026-11-10"), r.phrases[0].days)
    }

    @Test
    fun afterLunchDay2() {
        val r = TimePhrases.parse("after lunch day 2", kubecon)
        assertEquals("", r.text)
        assertEquals(listOf("after-lunch", "day-2"), r.phrases.map { it.key })
        assertEquals(listOf("After lunch", "Day 2"), r.phrases.map { it.label })
        assertEquals(listOf("2026-11-10"), r.phrases[1].days)
    }

    @Test
    fun unknownDaysStayInTheText() {
        val r = TimePhrases.parse("day 9 friday", kubecon)
        assertEquals("day 9 friday", r.text)
        assertEquals(emptyList(), r.phrases)
        assertEquals(emptyList(), keys("day 0"))
        assertEquals(listOf("day-4"), keys("day4"), "the space is optional")
    }

    @Test
    fun leadInsCaseAndPunctuation() {
        assertEquals("eBPF", TimePhrases.parse("eBPF on Wednesday, in the MORNING.", kubecon).text)
        assertEquals(listOf("wednesday", "morning"), keys("eBPF on Wednesday, in the MORNING."))
        assertEquals("talks", TimePhrases.parse("talks during   before   lunch", kubecon).text)
        assertEquals(listOf("before-lunch"), keys("talks during   before   lunch"))
        assertEquals(listOf("morning"), keys("morning morning"), "a phrase is listed once")
        assertEquals(emptyList(), keys("mornings and afternoons"), "whole words only")
    }

    @Test
    fun lunchNeedsALunchBreak() {
        val noLunch = kubecon.copy(lunch = emptyMap())
        assertEquals(emptyList(), keys("after lunch", noLunch))
        assertEquals("after lunch", TimePhrases.parse("after lunch", noLunch).text)
    }

    @Test
    fun dayPhrasesNeedADateRange() {
        val undated = kubecon.copy(startDate = null, endDate = null)
        assertEquals(emptyList(), keys("day 1", undated))
        // Without an end date, the start date alone bounds the days.
        assertEquals(listOf("day-1"), keys("day 1", kubecon.copy(endDate = null)))
        assertEquals(emptyList(), keys("day 2", kubecon.copy(endDate = null)))
    }

    @Test
    fun ignoredPhrasesLeaveTheTextButDoNotApply() {
        val r = TimePhrases.parse("ebpf tuesday afternoon", kubecon, ignored = setOf("tuesday"))
        assertEquals("ebpf", r.text)
        assertEquals(listOf(false, true), r.phrases.map { it.applied })
    }
}
