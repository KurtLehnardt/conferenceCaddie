package app.conferencecaddie.shared.search

import app.conferencecaddie.shared.bundle.Talk
import app.conferencecaddie.shared.bundle.TalkBundle
import app.conferencecaddie.shared.db.CaddieDatabase
import kotlin.time.Clock
import kotlin.time.Instant
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime

/** What the person asked for: the search text and the filters, as the web app sends them. */
data class SearchRequest(
    val query: String = "",
    /** One day, `YYYY-MM-DD`, or null for every day. */
    val day: String? = null,
    val tracks: Set<String> = emptySet(),
    val levels: Set<String> = emptySet(),
    /** Selected tag values by tag group; values of one group are alternatives, groups narrow. */
    val tags: Map<String, Set<String>> = emptyMap(),
    /** True or false keeps only talks with or without slides; null keeps both. */
    val hasSlides: Boolean? = null,
    /** Speaker and room names from tapped suggestion chips. */
    val speakers: Set<String> = emptySet(),
    val rooms: Set<String> = emptySet(),
    /** Minutes after midnight, conference time: start at or after, and before. */
    val startAfter: Int? = null,
    val startBefore: Int? = null,
    val hideSponsor: Boolean = false,
    val happeningNow: Boolean = false,
    /** Include co-located events and showcases (kind ambient). */
    val includeEvents: Boolean = false,
    /** Time phrases the person removed: they leave the text but filter nothing. */
    val ignorePhrases: Set<String> = emptySet(),
)

data class FacetCount<T>(val value: T, val count: Int)

data class TagFacet(val group: String, val values: List<FacetCount<String>>)

data class Facets(
    val day: List<FacetCount<String>>,
    val track: List<FacetCount<String>>,
    /** Null when the conference has no level. */
    val level: List<FacetCount<String>>?,
    val hasSlides: List<FacetCount<Boolean>>,
    val tags: List<TagFacet>,
)

data class SearchResult(
    /** How many talks match; [talks] holds all of them, best first. */
    val total: Int,
    /** The text the keyword search saw, after time phrases left it. */
    val searchText: String,
    val timePhrases: List<TimePhrases.Phrase>,
    val suggestions: List<Suggestions.Suggestion>,
    /** Whether the Happening now chip applies: the conference has talks today in its own time zone. */
    val happeningNowAvailable: Boolean,
    val talks: List<Talk>,
    val facets: Facets,
)

/**
 * Keyword search over one conference's bundle, with the behaviour of the server's
 * `POST /api/search` (server/search.mjs) minus the semantic leg, which arrives in phase 2b:
 *
 * - Text: SQLite FTS5 over title, abstract, speakers, taglines, topics, track and room, with the
 *   Porter stemmer as the server's english analyzer has, and English stop words dropped. Queries of
 *   one or two terms must match every term; longer ones must match 60% of them (the server's
 *   `minimum_should_match: "2<60%"`). Results are ordered by BM25, then by talk id.
 * - Empty text (browse mode): every talk, by start, then talk id.
 * - Base filters B: kind (talk, or talk and ambient with [SearchRequest.includeEvents]), the start
 *   window, speakers, rooms, hide sponsor, Happening now (in progress or starting within 60
 *   minutes) and the time phrases.
 * - Facet groups S: day, track, level, has slides, and one group per tag group. The count shown for
 *   a value of group g is computed over the matches, B and every selection except g's, so it is the
 *   total the person gets after selecting it. A selected value with no matches is listed with 0.
 */
class TalkSearch(
    private val bundle: TalkBundle,
    private val scope: String,
    private val database: CaddieDatabase,
    private val now: () -> Instant = { Clock.System.now() },
) {
    private val shape = TimePhrases.Shape.of(bundle.conference.startDate, bundle.conference.endDate, bundle.talks)

    suspend fun search(request: SearchRequest): SearchResult {
        val time = TimePhrases.parse(request.query.trim().take(MAX_QUERY), shape, request.ignorePhrases)
        val text = time.text
        val nowMs = now().toEpochMilliseconds()

        // M: the talks the text matches, in rank order; every talk in browse mode.
        val matched: List<Talk> = if (text.isBlank()) {
            bundle.talks
        } else {
            lexical(text).mapNotNull { bundle.talksById[it] }
        }

        val base = matched.filter { t -> passesBase(t, request, time.filter, nowMs) }
        val groups = selections(request)
        val results = base.filter { t -> groups.all { it.test(t) } }

        fun except(name: String) = base.filter { t -> groups.all { it.name == name || it.test(t) } }

        val facets = Facets(
            day = counts(except("day").map { it.day }, listOfNotNull(request.day)).sortedBy { it.value },
            track = counts(except("track").mapNotNull { it.track }, request.tracks),
            level = if (bundle.conference.hasLevel) counts(except("level").mapNotNull { it.level }, request.levels) else null,
            hasSlides = except("has_slides").let { list ->
                listOf(FacetCount(true, list.count { it.hasSlides }), FacetCount(false, list.count { !it.hasSlides }))
            },
            tags = bundle.conference.tagGroups.map { group ->
                val values = except("tag:$group").flatMap { t -> t.tags.filter { it.group == group }.map { it.value }.distinct() }
                TagFacet(group, counts(values, request.tags[group].orEmpty()))
            },
        )

        val suggestions = if (text.isBlank()) {
            emptyList()
        } else {
            Suggestions.suggest(
                text,
                bundle.facets,
                Suggestions.Selected(
                    tracks = request.tracks,
                    rooms = request.rooms,
                    speakers = request.speakers,
                    tags = request.tags.values.flatten().toSet(),
                ),
            )
        }

        return SearchResult(
            total = results.size,
            searchText = text,
            timePhrases = time.phrases,
            suggestions = suggestions,
            happeningNowAvailable = runningToday(nowMs),
            talks = results,
            facets = facets,
        )
    }

    /** The talks of the bundle's `related` list for [talkId], most similar first. */
    fun related(talkId: String): List<Talk> = bundle.related[talkId].orEmpty().mapNotNull { bundle.talksById[it] }

    /** Whether the conference has a talk on today's date in its own time zone. */
    fun runningToday(nowMs: Long): Boolean {
        val zone = bundle.conference.timeZone?.let { runCatching { TimeZone.of(it) }.getOrNull() } ?: TimeZone.UTC
        val today = Instant.fromEpochMilliseconds(nowMs).toLocalDateTime(zone).date.toString()
        return bundle.talks.any { it.kind == "talk" && it.day == today }
    }

    private suspend fun lexical(text: String): List<String> {
        val terms = terms(text)
        if (terms.isEmpty()) return emptyList()
        val quoted = terms.map { "\"" + it.replace("\"", "\"\"") + "\"" }
        val (sets, ranked) = database.match(scope, quoted, quoted.joinToString(" OR "))
        val required = if (terms.size <= 2) terms.size else maxOf(1, (terms.size * 3) / 5)
        val hits = HashMap<String, Int>()
        for (set in sets) for (id in set) hits[id] = (hits[id] ?: 0) + 1
        return ranked.filter { (hits[it] ?: 0) >= required }
    }

    private fun passesBase(t: Talk, r: SearchRequest, phrases: TimePhrases.Filter, nowMs: Long): Boolean {
        if (t.kind != "talk" && !(r.includeEvents && t.kind == "ambient")) return false
        if (r.startAfter != null && t.startMinutes < r.startAfter) return false
        if (r.startBefore != null && t.startMinutes >= r.startBefore) return false
        if (r.speakers.isNotEmpty() && r.speakers.none { name -> t.speakers.any { speakerMatches(it, name) } }) return false
        if (r.rooms.isNotEmpty() && t.room !in r.rooms) return false
        if (r.hideSponsor && t.sponsor) return false
        if (r.happeningNow && !(t.endEpochMs > nowMs && t.startEpochMs < nowMs + HAPPENING_NOW_AHEAD_MS)) return false
        return phrases.matches(t)
    }

    private class Group(val name: String, val test: (Talk) -> Boolean)

    private fun selections(r: SearchRequest): List<Group> = buildList {
        if (r.day != null) add(Group("day") { it.day == r.day })
        if (r.tracks.isNotEmpty()) add(Group("track") { it.track in r.tracks })
        if (r.levels.isNotEmpty() && bundle.conference.hasLevel) add(Group("level") { it.level in r.levels })
        if (r.hasSlides != null) add(Group("has_slides") { it.hasSlides == r.hasSlides })
        for ((group, values) in r.tags) {
            if (values.isNotEmpty()) add(Group("tag:$group") { t -> t.tags.any { it.group == group && it.value in values } })
        }
    }

    // Counts by value, most frequent first and then by value, as an Elasticsearch terms aggregation
    // orders them; selected values with no match are added with 0.
    private fun counts(values: List<String>, selected: Collection<String>): List<FacetCount<String>> {
        val list = values.groupingBy { it }.eachCount().map { FacetCount(it.key, it.value) }
            .sortedWith(compareByDescending<FacetCount<String>> { it.count }.thenBy { it.value })
            .toMutableList()
        for (v in selected) if (list.none { it.value == v }) list += FacetCount(v, 0)
        return list
    }

    companion object {
        const val MAX_QUERY = 200
        const val HAPPENING_NOW_AHEAD_MS = 60 * 60 * 1000L

        /** Lucene's English stop words, which the server's english analyzer drops. */
        val STOP_WORDS = setOf(
            "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "if", "in", "into", "is", "it", "no", "not",
            "of", "on", "or", "such", "that", "the", "their", "then", "there", "these", "they", "this", "to", "was",
            "will", "with",
        )

        /** The distinct search terms of [text]: letters and digits, lower case, stop words dropped. */
        fun terms(text: String): List<String> = normalizeKey(text).split(' ')
            .filter { it.isNotEmpty() && it !in STOP_WORDS }
            .distinct()
            .take(MAX_TERMS)

        private const val MAX_TERMS = 32

        // The server matches a speaker name as a phrase inside the speakers field.
        private fun speakerMatches(speaker: String, name: String): Boolean {
            val s = " ${normalizeKey(speaker)} "
            val n = normalizeKey(name)
            return n.isNotEmpty() && s.contains(" $n ")
        }
    }
}
