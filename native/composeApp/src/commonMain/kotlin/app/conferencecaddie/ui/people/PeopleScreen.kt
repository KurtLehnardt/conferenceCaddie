package app.conferencecaddie.ui.people

import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import app.conferencecaddie.shared.people.PeoplePrivacy
import app.conferencecaddie.shared.people.PeopleUiState
import app.conferencecaddie.shared.people.Person
import app.conferencecaddie.shared.people.Proximity
import app.conferencecaddie.shared.people.SyncStatus
import app.conferencecaddie.ui.components.ButtonVariant
import app.conferencecaddie.ui.components.CaddieButton
import app.conferencecaddie.ui.components.CaddieChip
import app.conferencecaddie.ui.components.DemoNote
import app.conferencecaddie.ui.components.showsDemoLabel
import app.conferencecaddie.ui.icons.LucideIcon
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** The pause before what is typed in the people search is searched for (web DEBOUNCE_MS). */
private const val SEARCH_DEBOUNCE_MS = 350L

/** How long a card "See who" landed on stays ringed (web nudges.ts revealIn). */
private const val REVEAL_RING_MS = 4_000L

/** How long "See who" waits for the list that should hold the person before it gives up. */
private const val REVEAL_WAIT_MS = 15_000L

/**
 * The People tab (web PeopleScreen.tsx, spec section 2), drawn by [PeopleTab] only online, with
 * people features on and a conference ready. Top to bottom, each part hiding itself when it does
 * not apply: U3's [StillHereRow], U3's [NudgeBanner] (its `onSeeWho` collapses the search into the
 * Around view), U3's [PresenceControls], the search block (the field "What are you working on, or
 * about to?" of at most 300 characters, searched 350 ms after typing stops, and the "Around now"
 * chip; "Back to who's around" while presence is on), U1's [EndedTalkBanner] while not searching,
 * the people list under its title, and on the Around home "Find someone specific".
 *
 * Modes, as on the web: with presence off the search is open and the list is "People to meet",
 * "People who match" (a query) or "People around now" (the chip alone), fetched 20 at a time with
 * `controller.searchPeople(query, around, from)` and extended as its end comes into view ("Finding
 * more people…"). With presence on (`state.presence.on` and a zone) the tab is the Around home: "Who's
 * around" from `state.around`, which the controller keeps fresh while `setAroundVisible(true)` says
 * it shows (set and cleared through `host.scope`, so the last call runs after the screen leaves),
 * grouped "In {zone}" (or "Nobody else in {zone} yet") and "Elsewhere at the venue" through
 * PeoplePrivacy; "Find someone specific" opens the search with Around now on.
 *
 * The list's states: no name ("Find people worth meeting", Create my profile), not visible ("Turn on
 * visibility to see who to meet", `controller.setOpenToMeet(true)`), "Finding people…", the error,
 * the empty lines, and the results with [SampleNote] and a [PersonCard] each; blocked people are
 * left out at once. While a new list is fetched the old one stays, dimmed, under a [RefreshBar]; a
 * quiet refresh of the same list does not dim it. `state.reveal` ("See who") opens the Around view,
 * scrolls its card to the middle and rings it for four seconds, then `controller.consumeReveal()`.
 *
 * [request] is what a link (a tapped notification among them) or another screen asked for
 * (`aroundNow`: the Around view; `query`: a search with the bar open; `hereZone`: for
 * PresenceControls); the screen does it, then calls `host.requestHandled(request)`. Owner U2.
 */
@Composable
fun PeopleScreen(
    state: PeopleUiState,
    host: PeopleHost,
    talks: PeopleTalks,
    request: PeopleRequest?,
    modifier: Modifier = Modifier,
) {
    val controller = host.controller
    val slug = state.conference?.slug.orEmpty()
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    val focus = remember { FocusRequester() }

    // The search bar: the text as typed, the query it settles into, the chip, and whether the
    // search is open over the Around home.
    var input by rememberSaveable(slug) { mutableStateOf("") }
    var query by rememberSaveable(slug) { mutableStateOf("") }
    var aroundChip by rememberSaveable(slug) { mutableStateOf(false) }
    var findOpen by rememberSaveable(slug) { mutableStateOf(false) }
    var pendingHere by remember { mutableStateOf<String?>(null) }
    var focusSearch by remember { mutableStateOf(false) }
    val debounce = remember { DebounceJob() }

    val onInput: (String) -> Unit = { text ->
        input = text
        debounce.job?.cancel()
        if (text.isBlank()) {
            query = ""
        } else {
            debounce.job = scope.launch {
                delay(SEARCH_DEBOUNCE_MS)
                query = text
            }
        }
    }

    val presence = state.presence
    val myZone = presence.zone?.takeIf { presence.on }
    val presenceOn = myZone != null
    // Home is Around: with presence on and the search collapsed, the tab shows who's around.
    val aroundHome = presenceOn && !findOpen
    val searchOpen = !presenceOn || findOpen
    val around = state.features.presence && (aroundHome || aroundChip)
    val searching = !aroundHome && (query.isNotBlank() || around)
    val title = when {
        aroundHome -> PeopleStrings.AROUND_TITLE
        searching -> if (around && query.isBlank()) PeopleStrings.PEOPLE_AROUND_NOW else PeopleStrings.PEOPLE_WHO_MATCH
        else -> PeopleStrings.PEOPLE_TO_MEET
    }

    // The Around view: "See who", a nudge's caddie://people?around=1, "Around now" from elsewhere.
    val showAround: () -> Unit = {
        onInput("")
        if (presenceOn) {
            findOpen = false
        } else {
            aroundChip = true
            findOpen = true
        }
    }
    val openFind: () -> Unit = {
        aroundChip = presenceOn
        findOpen = true
        focusSearch = true
    }
    val closeFind: () -> Unit = {
        onInput("")
        findOpen = false
    }

    LaunchedEffect(request) {
        val r = request ?: return@LaunchedEffect
        r.query?.let { text ->
            debounce.job?.cancel()
            input = text.take(PEOPLE_QUERY_MAX)
            query = input
            aroundChip = false
            findOpen = true
        }
        if (r.aroundNow) showAround()
        r.hereZone?.let { pendingHere = it }
        host.requestHandled(r)
    }

    LaunchedEffect(focusSearch) {
        if (!focusSearch) return@LaunchedEffect
        listState.animateScrollToItem(0)
        withFrameNanos { }
        runCatching { focus.requestFocus() }
        focusSearch = false
    }

    // The controller refreshes the Around page while it shows.
    DisposableEffect(aroundHome) {
        if (aroundHome) host.scope.launch { controller.setAroundVisible(true) }
        onDispose { if (aroundHome) host.scope.launch { controller.setAroundVisible(false) } }
    }

    // Matches come from the server's copy of the profile, so while an edit is still being written
    // they would describe the old one: the fetch waits for the write to finish.
    val saving = state.sync.state == SyncStatus.State.Saving
    val named = state.profile.displayName.isNotBlank()
    val visible = state.visibility.openToMeet
    val interestedKey = talks.interested.joinToString(",")

    // The search list, fetched again when the app comes back to the foreground (the web's visibleTick).
    val pager = remember(controller) { PeopleHomePager(controller, scope) }
    val searchQuery = query.trim().ifEmpty { null }
    val searchKey = "$slug|${state.saveCount}|$interestedKey|${searchQuery.orEmpty()}|$around|$presenceOn"
    var resumes by remember { mutableIntStateOf(0) }
    val firstResume = remember { BooleanArray(1) { true } }
    LifecycleResumeEffect(Unit) {
        if (firstResume[0]) firstResume[0] = false else resumes++
        onPauseOrDispose { }
    }
    LaunchedEffect(searchKey, visible, saving, named, aroundHome, resumes) {
        if (aroundHome || !visible || saving || !named) return@LaunchedEffect
        pager.load(searchKey, searchQuery, around)
    }

    // The Around list: the controller's first page, then pages of its own. A new zone, profile or
    // Interested list fetches it again; the controller's two-minute refresh is quiet (not dimmed).
    val aroundView = state.around
    val aroundKey = "$slug|${state.saveCount}|$interestedKey|${myZone.orEmpty()}"
    val aroundPager = remember(controller) { PeopleHomePager(controller, scope) }
    val lastAroundKey = remember { arrayOfNulls<String>(1) }
    LaunchedEffect(aroundHome, aroundKey, saving) {
        if (!aroundHome) {
            lastAroundKey[0] = null
            return@LaunchedEffect
        }
        if (aroundPager.page?.key != aroundKey) aroundPager.start(aroundKey, PEOPLE_PAGE_SIZE)
        if (saving) return@LaunchedEffect
        val previous = lastAroundKey[0]
        lastAroundKey[0] = aroundKey
        if (previous != null && previous != aroundKey) controller.refreshAround()
    }
    var aroundShownKey by remember { mutableStateOf<String?>(null) }
    val currentAroundKey by rememberUpdatedState(aroundKey)
    val currentAround by rememberUpdatedState(aroundView)
    LaunchedEffect(Unit) {
        var wasLoading = false
        snapshotFlow { currentAround.loading }.collect { loading ->
            if (wasLoading && !loading) aroundShownKey = currentAroundKey
            wasLoading = loading
        }
    }

    // What the list shows.
    val blocked = state.blocks.mapTo(HashSet()) { it.ref }
    val inMyZone: (Person) -> Boolean = { p ->
        PeoplePrivacy.proximity(p, presenceOn) == Proximity.SameZone || PeoplePrivacy.inMyZone(p, presence)
    }
    var refreshing = false
    var loadingMore = false
    val rows: List<PeopleHomeRow> = when {
        !named -> listOf(PeopleHomeRow.CreateProfile)
        !visible -> listOf(PeopleHomeRow.Visibility)
        aroundHome -> {
            val extra = aroundPager.page?.takeIf { it.key == aroundKey }
            val error = aroundView.error
            when {
                error != null && !aroundView.loading -> listOf(PeopleHomeRow.Failure(error.message.ifBlank { PeopleStrings.UNAVAILABLE }))
                !aroundView.loaded -> listOf(PeopleHomeRow.Hint(PeopleStrings.FINDING))
                else -> {
                    val first = aroundView.people
                    val listed = first.mapTo(HashSet()) { it.ref }
                    val results = (first + extra?.results.orEmpty().filter { it.ref !in listed }).filter { it.ref !in blocked }
                    refreshing = saving || (aroundView.loading && aroundShownKey != aroundKey)
                    loadingMore = aroundPager.loadingMore
                    // The controller's first page says whether the server has more after it.
                    val more = extra != null && !extra.done && aroundView.hasMore && !refreshing
                    if (results.isEmpty()) listOf(PeopleHomeRow.Hint(PeopleStrings.AROUND_EMPTY)) else peopleHomeRows(results, myZone, inMyZone, more)
                }
            }
        }
        else -> {
            val page = pager.page?.takeIf { it.key.startsWith("$slug|") }
            val error = pager.error
            when {
                error != null -> listOf(PeopleHomeRow.Failure(error))
                page == null -> listOf(PeopleHomeRow.Hint(PeopleStrings.FINDING))
                else -> {
                    val results = page.results.filter { it.ref !in blocked }
                    refreshing = saving || page.key != searchKey
                    loadingMore = pager.loadingMore
                    when {
                        results.isEmpty() -> listOf(PeopleHomeRow.Hint(if (searching) PeopleStrings.SEARCH_EMPTY else PeopleStrings.NO_MATCHES))
                        else -> peopleHomeRows(results, null, inMyZone, more = !page.done && !refreshing)
                    }
                }
            }
        }
    }
    val cards = rows.mapNotNull { (it as? PeopleHomeRow.Card)?.person }
    val morePage = if (aroundHome) aroundPager.page else pager.page
    val loadMore: () -> Unit = {
        if (aroundHome) aroundPager.loadMore(aroundKey, null, true) else pager.loadMore(searchKey, searchQuery, around)
    }

    // "See who": the Around view, then its card in the middle of the screen, ringed for a while.
    var revealedRef by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(revealedRef) {
        if (revealedRef != null) {
            delay(REVEAL_RING_MS)
            revealedRef = null
        }
    }
    val currentRows by rememberUpdatedState(rows)
    val currentAroundHome by rememberUpdatedState(aroundHome)
    val searchReady by rememberUpdatedState(!aroundHome && around && query.isEmpty() && pager.page?.key == searchKey)
    LaunchedEffect(state.reveal) {
        val ref = state.reveal ?: return@LaunchedEffect
        val home = presenceOn
        showAround()
        withTimeoutOrNull(REVEAL_WAIT_MS) {
            if (home) {
                snapshotFlow { currentAroundHome }.first { it }
                // "See who" fetches the Around page again: wait for it unless the card is already there.
                var sawLoading = false
                snapshotFlow { currentAround }.first { v ->
                    if (v.loading) sawLoading = true
                    v.people.any { it.ref == ref } || (sawLoading && v.loaded && !v.loading)
                }
            } else {
                snapshotFlow { searchReady }.first { it }
            }
        }
        withFrameNanos { }
        val index = currentRows.indexOfFirst { it is PeopleHomeRow.Card && it.person.ref == ref }
        if (index >= 0) {
            revealedRef = ref
            // The top blocks and the list's title come before the rows.
            val item = index + 2
            listState.animateScrollToItem(item)
            val layout = listState.layoutInfo
            layout.visibleItemsInfo.firstOrNull { it.index == item }?.let { info ->
                val viewport = layout.viewportEndOffset - layout.viewportStartOffset
                listState.animateScrollBy(info.offset + info.size / 2f - viewport / 2f)
            }
        }
        // Consumed either way, so a person who has left the list is not ringed later by surprise.
        controller.consumeReveal()
    }

    LazyColumn(
        // The keyboard is not avoided for the app as a whole, so the list makes room for it itself.
        modifier.fillMaxSize().imePadding().testTag("people-screen"),
        state = listState,
        contentPadding = PeopleScreenPadding,
    ) {
        if (showsDemoLabel(state.conference?.demo)) {
            item(key = "demo", contentType = "demo") { DemoNote(true, Modifier.padding(bottom = PeopleScreenGap)) }
        }
        item(key = "top", contentType = "top") {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(PeopleScreenGap)) {
                StillHereRow(state, host)
                NudgeBanner(state, host, onSeeWho = showAround)
                PresenceControls(state, host, hereZone = pendingHere, onHereZoneHandled = { pendingHere = null })
                if (searchOpen) {
                    PeopleHomeSearchBlock(
                        input = input,
                        onInput = onInput,
                        focus = focus,
                        around = around,
                        showChip = state.features.presence,
                        onAround = { aroundChip = it },
                        onBack = if (presenceOn) closeFind else null,
                    )
                }
                if (!searching) EndedTalkBanner(talks, state, host)
            }
        }
        item(key = "title", contentType = "title") {
            SectionHead(title, Modifier.padding(top = PeopleScreenGap).testTag("people-list-title"))
        }
        itemsIndexed(rows, key = { _, row -> row.key }, contentType = { _, row -> row::class }) { index, row ->
            // .pp-section: 10 dp under the title; .pp-list: 12 dp between rows.
            Box(Modifier.fillMaxWidth().padding(top = if (index == 0) 10.dp else 12.dp)) {
                Box(Modifier.fillMaxWidth().refreshing(refreshing)) {
                    when (row) {
                        PeopleHomeRow.CreateProfile -> PeopleHomeCreateProfilePrompt(host)
                        PeopleHomeRow.Visibility -> PeopleHomeVisibilityPrompt(host)
                        is PeopleHomeRow.Hint -> HintText(row.text, pad = true)
                        is PeopleHomeRow.Failure -> ErrorText(row.text, pad = true)
                        PeopleHomeRow.Sample -> SampleNote(cards)
                        is PeopleHomeRow.Group -> GroupTitle(row.title)
                        is PeopleHomeRow.Card -> PersonCard(row.person, state, host, revealed = row.person.ref == revealedRef)
                        PeopleHomeRow.More -> {
                            PeopleHomeMore(loadingMore)
                            // Composed only as it comes into view: the next page, once per page.
                            LaunchedEffect(morePage) { loadMore() }
                        }
                    }
                }
                if (index == 0 && cards.isNotEmpty()) RefreshBar(refreshing, Modifier.align(Alignment.TopCenter))
            }
        }
        if (aroundHome) {
            item(key = "find", contentType = "find") {
                CaddieButton(
                    PeopleStrings.FIND_LABEL,
                    openFind,
                    Modifier.fillMaxWidth().padding(top = PeopleScreenGap).testTag("people-find"),
                    variant = ButtonVariant.Tonal,
                    icon = LucideIcon.Search,
                )
            }
        }
        // The web's ForYouRow, last on the home and left out while a search shows.
        val forYouRow = talks.forYouRow
        if (!searching && forYouRow != null) {
            item(key = "for-you", contentType = "for-you") {
                Box(Modifier.fillMaxWidth().padding(top = PeopleScreenGap)) { forYouRow() }
            }
        }
    }
}

/** The pending debounce of the search field. */
private class DebounceJob {
    var job: Job? = null
}

/**
 * .pp-search, and below it "Back to who's around" while presence is on ([onBack]): the search
 * field and, 8 dp under it, the "Around now" chip ([showChip] while the backend offers presence).
 */
@Composable
private fun PeopleHomeSearchBlock(
    input: String,
    onInput: (String) -> Unit,
    focus: FocusRequester,
    around: Boolean,
    showChip: Boolean,
    onAround: (Boolean) -> Unit,
    onBack: (() -> Unit)?,
) {
    Column(Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            PeopleHomeSearchField(input, onInput, focus)
            if (showChip) {
                // .pp-search .chip: 40 dp tall; aria-pressed, so it toggles.
                CaddieChip(PeopleStrings.AROUND_NOW, around, { onAround(!around) }, Modifier.testTag("around-now-chip"), height = 40.dp)
            }
        }
        if (onBack != null) {
            CaddieButton(
                PeopleStrings.BACK_TO_AROUND,
                onBack,
                Modifier.padding(top = 4.dp).testTag("people-back-to-around"),
                variant = ButtonVariant.Text,
                small = true,
            )
        }
    }
}
