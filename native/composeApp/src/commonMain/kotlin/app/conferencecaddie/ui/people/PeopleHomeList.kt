package app.conferencecaddie.ui.people

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import app.conferencecaddie.shared.people.ApiResult
import app.conferencecaddie.shared.people.PeopleController
import app.conferencecaddie.shared.people.PeopleError
import app.conferencecaddie.shared.people.Person
import app.conferencecaddie.ui.components.StateAction
import app.conferencecaddie.ui.icons.LucideIcon
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

// The people list of the People home (web PeopleScreen.tsx PeopleList): its pages, the rows it is
// drawn as, and its prompts.

/** MATCH_PAGE (web api.ts): people come 20 at a time. */
internal const val PEOPLE_PAGE_SIZE = 20

/**
 * The people a list shows for one [key] (the conference, the profile's save count, the Interested
 * talks, the search, Around now and whether I am around): [results] in the server's order, the
 * `from` of the next page (the contract pages by `from + size`, since a page may hold fewer than
 * `size`), and whether there are no more.
 */
@Immutable
internal data class PeopleHomePage(val key: String, val results: List<Person>, val nextFrom: Int, val done: Boolean)

/**
 * Fetches a people list a page at a time with `controller.searchPeople` (web PeopleList): [load]
 * the first page, [loadMore] the next one when the end of the list comes into view, keeping the
 * earlier list on screen until the new one arrives. [scope] is the screen's, so leaving the screen
 * stops what is in flight.
 */
@Stable
internal class PeopleHomePager(private val controller: PeopleController, private val scope: CoroutineScope) {
    /** The list on screen, or null before the first page arrived. */
    var page: PeopleHomePage? by mutableStateOf(null)
        private set

    /** Why the last first page failed, or null. */
    var error: String? by mutableStateOf(null)
        private set

    /** True while the next page is fetched ("Finding more people…"). */
    var loadingMore: Boolean by mutableStateOf(false)
        private set

    private var more: Job? = null

    /** Starts [key] with no people yet and the next page at [from]: the pages of the Around view after its first, which the controller keeps. */
    fun start(key: String, from: Int) {
        more?.cancel()
        loadingMore = false
        error = null
        page = PeopleHomePage(key, emptyList(), from, done = false)
    }

    /**
     * The first page for [key]. A failure keeps the earlier list and says why, except the refusals
     * that mean my profile is no longer visible: the controller turns visibility off on the device
     * for those, and the screen shows the visibility prompt again.
     */
    suspend fun load(key: String, query: String?, around: Boolean) {
        error = null
        when (val res = controller.searchPeople(query, around, 0)) {
            is ApiResult.Ok -> {
                more?.cancel()
                loadingMore = false
                page = PeopleHomePage(key, res.value.results, res.value.from + res.value.size, done = !res.value.hasMore)
            }
            is ApiResult.Failed -> if (res.error.kind != PeopleError.Kind.VisibilityRequired && res.error.kind != PeopleError.Kind.NoDevice) {
                error = res.error.message.ifBlank { PeopleStrings.UNAVAILABLE }
            }
        }
    }

    /** Appends the next page of [key], once at a time; people already listed are not listed twice, and a failure ends the list. */
    fun loadMore(key: String, query: String?, around: Boolean) {
        val from = page ?: return
        if (from.done || from.key != key || more?.isActive == true) return
        loadingMore = true
        more = scope.launch {
            try {
                val res = controller.searchPeople(query, around, from.nextFrom)
                // A newer list took this one's place meanwhile: it is not extended.
                if (page !== from) return@launch
                page = when (res) {
                    is ApiResult.Ok -> {
                        val seen = from.results.mapTo(HashSet()) { it.ref }
                        from.copy(
                            results = from.results + res.value.results.filter { it.ref !in seen },
                            nextFrom = res.value.from + res.value.size,
                            done = !res.value.hasMore,
                        )
                    }
                    is ApiResult.Failed -> from.copy(done = true)
                }
            } finally {
                loadingMore = false
            }
        }
    }
}

/** One row of the people list, below its title. Each has a stable [key] for the lazy list. */
@Immutable
internal sealed interface PeopleHomeRow {
    val key: String

    /** CreateProfilePrompt: no name on the profile yet. */
    data object CreateProfile : PeopleHomeRow {
        override val key = "create-profile"
    }

    /** VisibilityPrompt: not visible at this conference. */
    data object Visibility : PeopleHomeRow {
        override val key = "visibility"
    }

    /** "Finding people…" or an empty list's words (.pp-hint.pp-pad). */
    data class Hint(val text: String) : PeopleHomeRow {
        override val key = "hint"
    }

    /** A failed list (.pp-error.pp-pad). */
    data class Failure(val text: String) : PeopleHomeRow {
        override val key = "error"
    }

    /** SampleNote above the first card when any is a sample. */
    data object Sample : PeopleHomeRow {
        override val key = "sample-note"
    }

    /** A group title of the Around home ("In {zone}", "Elsewhere at the venue"). */
    data class Group(val title: String, override val key: String) : PeopleHomeRow

    data class Card(val person: Person) : PeopleHomeRow {
        override val key = "person-${person.ref}"
    }

    /** .pp-more-sentinel: fetches the next page when it comes into view. */
    data object More : PeopleHomeRow {
        override val key = "more"
    }
}

/**
 * The rows of a list that has people ([results], blocked people already left out). On the Around
 * home ([groupZone] is my zone) the people in my zone come first under "In {zone}" (or "Nobody else
 * in {zone} yet"), then the rest under "Elsewhere at the venue", each group in the server's order;
 * [inMyZone] decides through PeoplePrivacy. [more] adds the next-page sentinel.
 */
internal fun peopleHomeRows(results: List<Person>, groupZone: String?, inMyZone: (Person) -> Boolean, more: Boolean): List<PeopleHomeRow> {
    val rows = ArrayList<PeopleHomeRow>()
    if (results.any { it.sample }) rows += PeopleHomeRow.Sample
    if (groupZone != null) {
        val inZone = results.filter(inMyZone)
        val elsewhere = results.filter { it !in inZone }
        rows += PeopleHomeRow.Group(if (inZone.isNotEmpty()) PeopleStrings.inZone(groupZone) else PeopleStrings.nobodyInZone(groupZone), "group-zone")
        inZone.mapTo(rows) { PeopleHomeRow.Card(it) }
        if (elsewhere.isNotEmpty()) {
            rows += PeopleHomeRow.Group(PeopleStrings.ELSEWHERE, "group-elsewhere")
            elsewhere.mapTo(rows) { PeopleHomeRow.Card(it) }
        }
    } else {
        results.mapTo(rows) { PeopleHomeRow.Card(it) }
    }
    if (more) rows += PeopleHomeRow.More
    return rows
}

/** CreateProfilePrompt (web PeopleScreen.tsx): "Find people worth meeting" and "Create my profile". */
@Composable
internal fun PeopleHomeCreateProfilePrompt(host: PeopleHost) {
    PeoplePrompt(
        PeopleStrings.CREATE_TITLE,
        Modifier.testTag("people-create-profile"),
        icon = LucideIcon.UserRound,
        body = PeopleStrings.CREATE_BODY,
        action = StateAction(PeopleStrings.CREATE_ACTION, host::openProfile),
    )
}

/**
 * VisibilityPrompt (web PeopleScreen.tsx): "Turn on visibility to see who to meet", the visibility
 * notice word for word, and "Make me visible" (disabled while it is saved). A refusal shows the
 * web's message and "Open my profile". The write runs in the app's scope, so it finishes even if
 * the screen goes meanwhile.
 */
@Composable
internal fun PeopleHomeVisibilityPrompt(host: PeopleHost) {
    // The same action as Profile's visibility switch, one at a time (PeopleHost.launchOnce); a message
    // after the prompt has gone goes in a toast ([shown]).
    val busy = host.isRunning(VISIBILITY_ACTION)
    var message by remember { mutableStateOf<String?>(null) }
    val shown = rememberInComposition()
    PeoplePrompt(
        PeopleStrings.VISIBILITY_TITLE,
        Modifier.testTag("people-visibility-prompt"),
        icon = LucideIcon.Users,
        body = PeopleStrings.VISIBILITY_BODY,
        notice = PeopleCommonStrings.VISIBILITY_NOTICE,
        action = StateAction(PeopleStrings.MAKE_VISIBLE, {
            host.launchOnce(VISIBILITY_ACTION) {
                val err = host.controller.setOpenToMeet(true)
                message = null
                if (err != null) {
                    if (shown.value) message = err else host.showMessage(err)
                }
            }
        }),
        actionEnabled = !busy,
        footer = message?.let { text -> { MessageWithLink(text, PeopleCommonStrings.OPEN_MY_PROFILE, host::openProfile) } },
    )
}

/**
 * .pp-more-sentinel: at least 24 dp at the end of a list with more pages, which the People screen
 * composes only as it comes into view and which then asks for the next page. It says "Finding more
 * people…" while [loading]; otherwise it is hidden from screen readers.
 */
@Composable
internal fun PeopleHomeMore(loading: Boolean, modifier: Modifier = Modifier) {
    Box(
        modifier
            .fillMaxWidth()
            .heightIn(min = 24.dp)
            .testTag("people-more")
            .then(if (loading) Modifier else Modifier.clearAndSetSemantics { }),
    ) {
        if (loading) HintText(PeopleStrings.FINDING_MORE)
    }
}
