package app.conferencecaddie.ui.talks

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import app.conferencecaddie.shared.search.SearchRequest
import app.conferencecaddie.shared.search.SearchResult
import app.conferencecaddie.shared.search.Suggestions
import app.conferencecaddie.ui.strings.Strings
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The Search screen's state, kept outside the composables so it survives tab switches, as the web
 * app keeps it in App (web/src/app.tsx), and, held by [SearchViewModel], configuration changes such
 * as a rotation. It resets when the conference changes, because filters name the old conference's
 * values.
 *
 * [runSearch] is the shared core's search over the installed bundle; it returns null while no
 * bundle is ready. Searches run in [scope], the scope of the composition that shows the screen;
 * [attach] replaces it when the screen is composed again, and a search the old scope cut short runs
 * again in the new one.
 */
class SearchModel(
    private var scope: CoroutineScope,
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

    /** The web's "Search is unavailable" message when the last search failed, else null. */
    var error by mutableStateOf<String?>(null)
        private set

    /** The filter sheet: null when closed, else the section to scroll to ("" for the top). */
    var sheet by mutableStateOf<String?>(null)

    private var slug: String? = null
    private var job: Job? = null
    private var unfinished = false

    /** Runs searches in [newScope] from now on, repeating one the previous scope cut short. */
    fun attach(newScope: CoroutineScope) {
        if (newScope === scope) return
        scope = newScope
        if (unfinished) search(debounce = false)
    }

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

    /** Runs the last search again, after a failure. */
    fun retry() = search(debounce = false)

    fun updateFilters(next: SearchRequest) {
        filters = next.copy(query = "")
        search(debounce = false)
    }

    /** Removes a time phrase's chip: the phrase stays in the text but stops filtering. */
    fun removePhrase(key: String) = updateFilters(filters.copy(ignorePhrases = filters.ignorePhrases + key))

    fun clearFilters() = updateFilters(SearchRequest(ignorePhrases = filters.ignorePhrases))

    /** Applies a "Did you mean" suggestion as a filter. */
    fun apply(s: Suggestions.Suggestion) = updateFilters(
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
        unfinished = true
        job = scope.launch {
            if (debounce) delay(DEBOUNCE_MS)
            loading = true
            try {
                val request = filters.copy(query = input)
                val r = runSearch(request)
                result = r
                error = null
                // A removed phrase that is no longer in the text is forgotten, so typing it again
                // filters again (web/src/app.tsx, runSearch).
                if (r != null) {
                    val kept = filters.ignorePhrases.filter { k -> r.timePhrases.any { it.key == k } }.toSet()
                    if (kept != filters.ignorePhrases) filters = filters.copy(ignorePhrases = kept)
                }
                unfinished = false
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // As on the web: the last results stay, with the message and a Retry.
                error = Strings.Search.UNAVAILABLE
                unfinished = false
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

/**
 * Holds the [SearchModel] for as long as the screen's owner lives (on Android, the activity across
 * a rotation). The model runs its searches in the composition's scope, not in a scope of its own,
 * so no search runs while nothing shows it.
 */
class SearchViewModel(scope: CoroutineScope, runSearch: suspend (SearchRequest) -> SearchResult?) : ViewModel() {
    val model = SearchModel(scope, runSearch)
}
