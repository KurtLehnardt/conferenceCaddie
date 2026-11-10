package app.conferencecaddie.ui.talks

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.conferencecaddie.shared.search.SearchRequest
import app.conferencecaddie.shared.search.SearchResult
import app.conferencecaddie.shared.search.Suggestions
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The Search screen's state, kept outside the composables so it survives tab switches, as the web
 * app keeps it in App (web/src/app.tsx). It resets when the conference changes, because filters
 * name the old conference's values.
 *
 * [runSearch] is the shared core's search over the installed bundle; it returns null while no
 * bundle is ready.
 */
class SearchModel(
    private val scope: CoroutineScope,
    private val runSearch: suspend (SearchRequest) -> SearchResult?,
) {
    /** The text in the search field. */
    var input by mutableStateOf("")
        private set

    /** The filters, and the time phrases the person removed. The query is [input]. */
    var filters by mutableStateOf(SearchRequest())
        private set

    var result by mutableStateOf<SearchResult?>(null)
        private set

    var loading by mutableStateOf(false)
        private set

    /** The filter sheet: null when closed, else the section to scroll to ("" for the top). */
    var sheet by mutableStateOf<String?>(null)

    private var slug: String? = null
    private var job: Job? = null

    /** Called when the selected conference or its bundle changes. */
    fun onConference(newSlug: String?, bundleHash: String?) {
        val key = "$newSlug|$bundleHash"
        if (key == loadedKey) return
        val conferenceChanged = newSlug != slug
        slug = newSlug
        loadedKey = key
        if (conferenceChanged) {
            input = ""
            filters = SearchRequest()
            result = null
            sheet = null
        }
        search(debounce = false)
    }

    private var loadedKey: String? = null

    fun onInput(text: String) {
        input = text.take(MAX_QUERY)
        search(debounce = true)
    }

    fun submit() = search(debounce = false)

    fun setFilters(next: SearchRequest) {
        filters = next.copy(query = "")
        search(debounce = false)
    }

    /** Removes a time phrase's chip: the phrase stays in the text but stops filtering. */
    fun removePhrase(key: String) = setFilters(filters.copy(ignorePhrases = filters.ignorePhrases + key))

    fun clearFilters() = setFilters(SearchRequest(ignorePhrases = filters.ignorePhrases))

    /** Applies a "Did you mean" suggestion as a filter. */
    fun apply(s: Suggestions.Suggestion) = setFilters(
        when (s.kind) {
            "track" -> filters.copy(tracks = filters.tracks + s.value)
            "room" -> filters.copy(rooms = filters.rooms + s.value)
            "speaker" -> filters.copy(speakers = filters.speakers + s.value)
            else -> filters.copy(tags = filters.tags + ((s.group ?: "") to (filters.tags[s.group ?: ""].orEmpty() + s.value)))
        },
    )

    val activeFilterCount: Int
        get() = activeFilterCount(filters)

    private fun search(debounce: Boolean) {
        job?.cancel()
        job = scope.launch {
            if (debounce) delay(DEBOUNCE_MS)
            loading = true
            try {
                val request = filters.copy(query = input)
                val r = runSearch(request)
                result = r
                // A removed phrase that is no longer in the text is forgotten, so typing it again
                // filters again (web/src/app.tsx, runSearch).
                if (r != null) {
                    val kept = filters.ignorePhrases.filter { k -> r.timePhrases.any { it.key == k } }.toSet()
                    if (kept != filters.ignorePhrases) filters = filters.copy(ignorePhrases = kept)
                }
            } finally {
                loading = false
            }
        }
    }

    companion object {
        const val DEBOUNCE_MS = 250L
        const val MAX_QUERY = 200

        /** The number the Filters chip shows, counted as web/src/components/search.tsx counts. */
        fun activeFilterCount(f: SearchRequest): Int =
            (if (f.day != null) 1 else 0) +
                (if (f.startAfter != null || f.startBefore != null) 1 else 0) +
                f.tracks.size + f.levels.size + f.tags.values.sumOf { it.size } + f.speakers.size + f.rooms.size +
                (if (f.hasSlides != null) 1 else 0) + (if (f.hideSponsor) 1 else 0) + (if (f.happeningNow) 1 else 0) +
                (if (f.includeEvents) 1 else 0)
    }
}
