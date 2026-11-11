package app.conferencecaddie.shared.importer

import app.conferencecaddie.shared.bundle.Attribution
import app.conferencecaddie.shared.bundle.Conference
import app.conferencecaddie.shared.bundle.IsoTime
import app.conferencecaddie.shared.bundle.Talk
import app.conferencecaddie.shared.bundle.TalkBundle

/**
 * The conference of test/import-bounds.test.mjs: four talks at testconf-2099, in America/Denver,
 * so the ported cases expect the same titles, speaker text and time hints as the server's test.
 */
internal object ImportFixtures {
    const val EVENT = "testconf-2099"
    const val ZONE = "America/Denver"

    fun talk(slug: String, n: Int, title: String, speakers: List<String>, start: String, kind: String = "talk"): Talk {
        val startMs = IsoTime.epochMillis(start)!!
        val minutes = start.substring(11, 13).toInt() * 60 + start.substring(14, 16).toInt()
        return Talk(
            talkId = "$slug:t$n", kind = kind, title = title, abstract = "", speakers = speakers,
            speakerTaglines = speakers.map { null }, room = "Room $n", track = null, level = null, tags = emptyList(),
            sponsor = false, hasSlides = false, slidesUrl = null, url = "https://example.org/$n",
            start = start, end = start, day = start.substring(0, 10), startMinutes = minutes, endMinutes = minutes + 30,
            topics = emptyList(), startEpochMs = startMs, endEpochMs = startMs + 30 * 60_000,
        )
    }

    val TALKS: List<Talk> = listOf(
        talk(EVENT, 1, "Inside the Kubernetes Scheduler", listOf("Xavier Dupont"), "2099-11-11T15:00:00-07:00"),
        talk(EVENT, 2, "Rust Operators for Kubernetes", listOf("Arjun Mehta"), "2099-11-12T09:30:00-07:00"),
        talk(EVENT, 3, "Running Postgres on Kubernetes Without Losing Sleep", listOf("Alice Moreau", "Bjorn Ek"), "2099-11-10T10:30:00-07:00"),
        talk(EVENT, 4, "Zero Trust Service Mesh in Practice", listOf("Pablo Ruiz"), "2099-11-11T10:00:00-07:00"),
    )

    /** The start of talk [n] (1 to 4), in milliseconds, as the server's test compares hints. */
    fun startOf(n: Int): Long = TALKS[n - 1].startEpochMs

    fun conference(slug: String = EVENT, zone: String? = ZONE, startDate: String? = "2099-11-10") = Conference(
        slug = slug, name = "Test Conference", startDate = startDate, endDate = "2099-11-12", timeZone = zone,
        location = Conference.Location("Denver", "Colorado", "United States", false), status = "searchable",
        officialScheduleUrl = null, source = "sessionize", hasLevel = false, trackGroup = null, tagGroups = emptyList(),
        talkCount = 4,
    )

    fun bundle(conference: Conference = conference(), talks: List<Talk> = TALKS) = TalkBundle(
        contentHash = "0".repeat(64),
        conference = conference,
        attribution = Attribution("Test", "CC BY 3.0", "https://creativecommons.org/licenses/by/3.0/", null, "", "https://example.org"),
        talks = talks,
        topics = emptyList(),
        facets = emptyList(),
        related = emptyMap(),
    )

    val importConference = ImportConference(EVENT, "2099-11-10", ZONE)

    fun file(text: String, filename: String, mime: String = "") = ImportInput.File(text.encodeToByteArray(), filename, mime)

    fun ics(vararg props: String): String = (listOf("BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT") + props + listOf("END:VEVENT", "END:VCALENDAR", "")).joinToString("\r\n")
}
