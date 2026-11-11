package app.conferencecaddie.ui.talks

import app.conferencecaddie.shared.bundle.Conference
import app.conferencecaddie.shared.bundle.IndexedConference
import app.conferencecaddie.shared.bundle.BundleStatus
import app.conferencecaddie.shared.bundle.Talk
import app.conferencecaddie.shared.bundle.TalkTime
import app.conferencecaddie.ui.components.CardLink
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.shell.ConferenceItem
import app.conferencecaddie.ui.shell.isWebLink
import app.conferencecaddie.ui.strings.Strings

// How a bundle's talks and conferences become the plain fields the shell's components draw, with
// the web app's rules (web/src/components/talk.tsx and switcher.tsx).

/** Track, level and tag values, skipping the feed's placeholder "Not specified". */
internal fun talkTags(talk: Talk): List<String> = buildList {
    talk.track?.takeIf { it.isNotEmpty() && it != NOT_SPECIFIED }?.let { add(it) }
    talk.level?.takeIf { it.isNotEmpty() && it != NOT_SPECIFIED }?.let { add(it) }
    talk.tags.forEach { add(it.value) }
}

private const val NOT_SPECIFIED = "Not specified"

/** "Tue, Nov 10 · 9:00–9:30 AM EST", in the conference's own time zone. */
internal fun whenText(talk: Talk, conference: Conference): String = TalkTime.`when`(talk, conference.timeZone)

/**
 * The official links under a card. Only http(s) links are offered, whatever the bundle holds, as
 * the contract asks of clients.
 */
internal fun cardLinks(talk: Talk): List<CardLink> = buildList {
    val event = talk.kind == "ambient"
    talk.url?.takeIf { isWebLink(it) }?.let {
        add(CardLink(if (event) Strings.Talk.EVENT_LINK else Strings.Talk.ADD_ON_OFFICIAL, LucideIcon.ExternalLink, it))
    }
    if (!event) talk.slidesUrl?.takeIf { isWebLink(it) }?.let { add(CardLink(Strings.Talk.SLIDES, LucideIcon.Presentation, it)) }
}


/** "Atlanta, United States" or "Virtual". */
internal fun place(conference: Conference): String =
    if (conference.location.virtual) Strings.Switcher.VIRTUAL else listOf(conference.location.city, conference.location.country).filter { it.isNotEmpty() }.joinToString(", ")

/** A conference as the switcher lists it. A conference without a usable bundle links to its official schedule. */
internal fun conferenceItem(c: IndexedConference): ConferenceItem {
    val conf = c.conference
    val range = if (conf.startDate != null && conf.endDate != null) TalkTime.dateRange(conf.startDate!!, conf.endDate!!) else null
    val searchable = conf.searchable && (c.bundleStatus == BundleStatus.Ok || c.bundleStatus == BundleStatus.Unsupported)
    return ConferenceItem(
        id = conf.slug,
        name = conf.name,
        meta = listOfNotNull(range, place(conf).takeIf { it.isNotEmpty() }).joinToString(" · "),
        searchable = searchable,
        officialUrl = conf.officialScheduleUrl?.takeIf { isWebLink(it) },
    )
}

/** The words of the search text that cards mark in the evidence. */
internal fun markTerms(searchText: String): List<String> {
    val words = ArrayList<String>()
    val sb = StringBuilder()
    for (ch in "$searchText ") {
        if (ch.isLetterOrDigit()) {
            sb.append(ch)
        } else {
            if (sb.length >= 2) words += sb.toString()
            sb.clear()
        }
    }
    return words
}
