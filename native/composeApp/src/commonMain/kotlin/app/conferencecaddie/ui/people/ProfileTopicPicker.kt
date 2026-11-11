package app.conferencecaddie.ui.people

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.FlowRowScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.findRootCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.conferencecaddie.shared.bundle.TalkBundle
import app.conferencecaddie.shared.bundle.Topic
import app.conferencecaddie.shared.people.TopicRef
import app.conferencecaddie.ui.components.ButtonVariant
import app.conferencecaddie.ui.components.CaddieButton
import app.conferencecaddie.ui.components.CaddieIconButton
import app.conferencecaddie.ui.components.LucideImage
import app.conferencecaddie.ui.components.Pill
import app.conferencecaddie.ui.components.focusRing
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie
import app.conferencecaddie.ui.theme.MOTION_MS
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// The topic picker of Profile (web TopicPicker.tsx, spec section 12): one per chip set. Not a modal:
// the chosen chips are pinned on top, then the type-ahead results, "Suggested for you" and the most
// common topics with "Show more". One tap adds a topic and one tap removes it.
//
// Chips never move under the finger. A tapped chip stays where it is in its list and only changes
// its look, so no other chip reflows. The pinned row grows or shrinks above the lists, and the page
// scrolls by the same amount so the lists stay still on screen. A chip removed from the pinned row
// stays there as an unselected ghost until taps have paused for a moment, so the chips beside it do
// not slide.
//
// The web asks the server for its topic lists (GET /api/topics, POST /api/topics/suggest). The
// native apps work from the conference's installed bundle instead, on the device, so the picker works
// offline: [ProfileTopics] orders and filters the bundle's topics the way the server's queries do.

/** How long a removed chip lingers in the pinned row after the last tap. */
private const val GHOST_MS = 1_200L

/** The common topics shown before "Show more". */
private const val FIRST = 12

/** How long the suggestions wait for typing to pause, as on the web. */
private const val SUGGEST_DEBOUNCE_MS = 600L

/** Where a long-pressed chip sits, so its action bar opens under that group. */
private enum class ChipGroup { Pinned, Hits, Suggested, Popular }

private data class HeldChip(val topic: TopicRef, val group: ChipGroup)

/**
 * The topic lists of a conference from its installed bundle, as the server's topic API orders them
 * (server/topics-api.mjs): the common topics by rank, the type-ahead over labels and aliases, and the
 * suggestions from marked talks and free text.
 */
internal object ProfileTopics {
    private const val COMMON_MAX = 150
    private const val HITS_MAX = 12
    private const val SUGGEST_MAX = 12
    private const val SUGGEST_FROM_TALKS = 8
    private const val QUERY_MAX = 60
    private const val TEXT_MAX = 500

    /** A topic found in the marked talks always outranks a label that matches the free text. */
    private const val TALK_TOPIC_BOOST = 1_000

    /** Words too common to suggest a topic on their own. */
    private val STOP_WORDS = setOf(
        "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "how", "i", "in", "is", "it", "my", "of", "on",
        "or", "our", "so", "that", "the", "to", "we", "what", "why", "with", "you",
    )

    /** "Common at this conference": the conference's topics by rank (GET /api/topics with no query). */
    fun common(bundle: TalkBundle): List<Topic> =
        bundle.topics.sortedWith(compareBy<Topic> { it.rank }.thenBy { it.label.lowercase() }).take(COMMON_MAX)

    /**
     * "Matching topics" for [query]: every word of it starts a word of the topic's label or of one of
     * its aliases (the server's bool_prefix match). An exact label first, then a label that starts
     * with the query, then the rest; ties by talk count, then label.
     */
    fun search(bundle: TalkBundle, query: String): List<Topic> {
        val q = query.take(QUERY_MAX).trim().lowercase()
        val terms = words(q)
        if (terms.isEmpty()) return emptyList()
        return bundle.topics.mapNotNull { t ->
            val names = listOf(t.label) + t.aliases
            val keys = names.flatMap { words(it) }
            if (!terms.all { term -> keys.any { it.startsWith(term) } }) return@mapNotNull null
            val score = when {
                names.any { it.lowercase() == q } -> 3
                names.any { it.lowercase().startsWith(q) } -> 2
                else -> 1
            }
            t to score
        }
            .sortedWith(compareByDescending<Pair<Topic, Int>> { it.second }.thenByDescending { it.first.talkCount }.thenBy { it.first.label.lowercase() })
            .take(HITS_MAX)
            .map { it.first }
    }

    /**
     * "Suggested for you": the topics of the marked [talkIds], most common first (the eight most
     * common), then the topics whose label or alias shares a word with [text]; at most twelve.
     */
    fun suggest(bundle: TalkBundle, talkIds: List<String>, text: String): List<Topic> {
        val scores = LinkedHashMap<String, Int>()
        val fromTalks = talkIds.distinct()
            .mapNotNull { bundle.talksById[it] }
            .filter { it.isTalk }
            .flatMap { it.topics.distinct() }
            .groupingBy { it }
            .eachCount()
        fromTalks.entries
            .sortedWith(compareByDescending<Map.Entry<String, Int>> { it.value }.thenBy { it.key })
            .take(SUGGEST_FROM_TALKS)
            .forEach { (id, n) -> scores[id] = TALK_TOPIC_BOOST + n }
        val textWords = words(text.take(TEXT_MAX)).filter { it !in STOP_WORDS }.toSet()
        if (textWords.isNotEmpty()) {
            for (t in bundle.topics) {
                val shared = (listOf(t.label) + t.aliases).flatMap { words(it) }.toSet().count { it in textWords }
                if (shared > 0) scores[t.topicId] = (scores[t.topicId] ?: 0) + shared
            }
        }
        return scores.mapNotNull { (id, score) -> bundle.topicsById[id]?.let { it to score } }
            .sortedWith(compareByDescending<Pair<Topic, Int>> { it.second }.thenByDescending { it.first.talkCount }.thenBy { it.first.label.lowercase() })
            .take(SUGGEST_MAX)
            .map { it.first }
    }

    /** The lower-case runs of letters and digits in [s]. */
    fun words(s: String): List<String> {
        val out = ArrayList<String>()
        val word = StringBuilder()
        for (ch in s) {
            if (ch.isLetterOrDigit()) {
                word.append(ch.lowercaseChar())
            } else if (word.isNotEmpty()) {
                out += word.toString()
                word.clear()
            }
        }
        if (word.isNotEmpty()) out += word.toString()
        return out
    }
}

/**
 * Keeps the lists under the pinned row still on screen when a tap changes the pinned row's height:
 * [arm] remembers where the search field was, and the next move of the field within two frames is
 * handed to the screen to scroll by. A field below the screen cannot be seen moving and is left alone.
 */
@Stable
private class PinnedAnchor {
    private var armed = false
    private var lastY = Float.NaN
    private var before = Float.NaN
    private var job: Job? = null

    fun arm(scope: CoroutineScope) {
        armed = true
        before = lastY
        job?.cancel()
        job = scope.launch {
            // The change lays out in the next frame; the one after that has nothing more to report.
            withFrameNanos { }
            withFrameNanos { }
            armed = false
        }
    }

    fun moved(y: Float, viewport: Float, onShift: (Float) -> Unit) {
        lastY = y
        if (!armed || before.isNaN() || y == before) return
        armed = false
        if (before < viewport) onShift(y - before)
    }
}

/**
 * TopicPicker: [title] (17/700, a heading) with "{n} of 30", the hold hint, the chosen topics
 * ([selected], pinned, in the order they were added), the search field, then either the matching
 * topics or "Suggested for you" (from [talkIds] and [suggestText]) and "Common at this conference"
 * from [bundle] (null while it loads). [onChange] gets the new chosen list; at most 30.
 *
 * A long press on a chip opens "Find people who've done this" under its group, which runs
 * [onFindPeople]. [onShift] is asked to scroll the page by the pixels the pinned row moved the lists.
 * [tag] prefixes the test tags of the picker's parts.
 */
@Composable
internal fun TopicPicker(
    title: String,
    selected: List<TopicRef>,
    onChange: (List<TopicRef>) -> Unit,
    bundle: TalkBundle?,
    suggestText: String,
    talkIds: List<String>,
    onFindPeople: (TopicRef) -> Unit,
    onShift: (Float) -> Unit,
    tag: String,
    modifier: Modifier = Modifier,
) {
    val c = Caddie.colors
    val scope = rememberCoroutineScope()
    var showAll by rememberSaveable { mutableStateOf(false) }
    var query by rememberSaveable { mutableStateOf("") }
    var ghosts by remember { mutableStateOf(emptyList<String>()) }
    var held by remember { mutableStateOf<HeldChip?>(null) }
    var suggested by remember { mutableStateOf(emptyList<Topic>()) }
    // The pinned row in display order, ghosts included; read and written while composing, as the
    // web keeps it in a ref.
    val pinned = remember { arrayOf(emptyList<TopicRef>()) }
    val prune = remember { arrayOfNulls<Job>(1) }
    val anchor = remember { PinnedAnchor() }

    val popular = remember(bundle) { bundle?.let { ProfileTopics.common(it) } }
    val trimmed = query.trim()
    val hits = remember(bundle, trimmed) { if (trimmed.isEmpty() || bundle == null) null else ProfileTopics.search(bundle, trimmed) }

    val idsKey = talkIds.joinToString(",")
    LaunchedEffect(bundle, idsKey, suggestText) {
        if (bundle == null || (talkIds.isEmpty() && suggestText.isBlank())) {
            suggested = emptyList()
            return@LaunchedEffect
        }
        delay(SUGGEST_DEBOUNCE_MS)
        suggested = ProfileTopics.suggest(bundle, talkIds, suggestText.trim())
    }

    val chosen = selected.map { it.topicId }.toSet()
    val full = selected.size >= ProfileStrings.MAX_TOPICS

    fun toggle(t: TopicRef) {
        val wasChosen = t.topicId in chosen
        val hadGhosts = ghosts.isNotEmpty()
        if (wasChosen) {
            anchor.arm(scope)
            onChange(selected.filter { it.topicId != t.topicId })
            if (t.topicId !in ghosts) ghosts = ghosts + t.topicId
        } else if (!full) {
            anchor.arm(scope)
            onChange(selected + TopicRef(t.topicId, t.label))
            ghosts = ghosts - t.topicId
        }
        // Every tap restarts the pause, so the pinned row settles only once the taps have stopped.
        if (hadGhosts || wasChosen) {
            prune[0]?.cancel()
            prune[0] = scope.launch {
                delay(GHOST_MS)
                anchor.arm(scope)
                ghosts = emptyList()
            }
        }
    }

    // What was pinned stays in place; new topics go on the end.
    val keep = chosen + ghosts
    val order = pinned[0].filter { it.topicId in keep }.toMutableList()
    for (t in selected) if (order.none { it.topicId == t.topicId }) order += t
    pinned[0] = order

    val onHold: (HeldChip) -> Unit = { held = it }
    val onFind: (TopicRef) -> Unit = {
        held = null
        onFindPeople(it)
    }
    val onCloseHeld = { held = null }
    val listed: (List<Topic>) -> List<ChipItem> = { list -> list.map { ChipItem(TopicRef(it.topicId, it.label), it.talkCount) } }

    Column(modifier.fillMaxWidth().semantics { isTraversalGroup = true }.testTag(tag), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        // .pp-hold-hint pulls itself 6 dp up, so the head and the hint sit 4 dp apart.
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    title,
                    style = Caddie.type.peopleCardTitle,
                    color = c.text,
                    modifier = Modifier.weight(1f).alignByBaseline().semantics { heading() },
                )
                Text(
                    ProfileStrings.topicCount(selected.size),
                    style = Caddie.type.note.copy(fontFeatureSettings = "tnum"),
                    color = c.text2,
                    modifier = Modifier.alignByBaseline(),
                )
            }
            Text(ProfileStrings.HOLD_HINT, style = Caddie.type.note, color = c.text2)
        }

        if (order.isNotEmpty()) {
            TopicGroup(
                "$tag-chosen", ChipGroup.Pinned, order.map { ChipItem(it, null) }, chosen,
                disabled = false, held = held, onToggle = ::toggle, onHold = onHold, onFind = onFind, onCloseHeld = onCloseHeld,
            )
        }

        TopicSearchField(
            query,
            { query = it },
            ProfileStrings.findTopicFor(title),
            Modifier.onGloballyPositioned { coords ->
                anchor.moved(coords.positionInRoot().y, coords.findRootCoordinates().size.height.toFloat(), onShift)
            },
            fieldTag = "$tag-search",
        )

        if (hits != null) {
            TopicGroup(
                "$tag-matching", ChipGroup.Hits, listed(hits), chosen,
                disabled = full, held = held, onToggle = ::toggle, onHold = onHold, onFind = onFind, onCloseHeld = onCloseHeld,
                empty = ProfileStrings.NO_TOPIC_MATCH,
            )
        } else {
            val sugg = suggested.take(12)
            if (sugg.isNotEmpty()) {
                Subhead(ProfileStrings.SUGGESTED_FOR_YOU)
                TopicGroup(
                    "$tag-suggested", ChipGroup.Suggested, listed(sugg), chosen,
                    disabled = full, held = held, onToggle = ::toggle, onHold = onHold, onFind = onFind, onCloseHeld = onCloseHeld,
                )
            }
            Subhead(ProfileStrings.COMMON_AT_CONFERENCE)
            if (popular == null) HintText(ProfileStrings.LOADING_TOPICS)
            val all = popular ?: emptyList()
            TopicGroup(
                "$tag-common", ChipGroup.Popular, listed(if (showAll) all else all.take(FIRST)), chosen,
                disabled = full, held = held, onToggle = ::toggle, onHold = onHold, onFind = onFind, onCloseHeld = onCloseHeld,
            )
            if (all.size > FIRST) {
                CaddieButton(
                    if (showAll) ProfileStrings.SHOW_FEWER else ProfileStrings.showMore(all.size - FIRST),
                    { showAll = !showAll },
                    Modifier.offset(x = (-8).dp),
                    variant = ButtonVariant.Text,
                    small = true,
                )
            }
        }
        if (full) HintText(ProfileStrings.TOPICS_FULL)
    }
}

/** One chip of a group: the topic, and its talk count when the list carries one (the pinned row does not). */
private data class ChipItem(val topic: TopicRef, val count: Int?)

/**
 * One group of chips ([group]: the chosen, matching, suggested or common topics), with the action
 * bar of a held chip of this group at its end, across the whole row. [empty] is the line shown when
 * there are no chips.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TopicGroup(
    tag: String,
    group: ChipGroup,
    chips: List<ChipItem>,
    chosen: Set<String>,
    disabled: Boolean,
    held: HeldChip?,
    onToggle: (TopicRef) -> Unit,
    onHold: (HeldChip) -> Unit,
    onFind: (TopicRef) -> Unit,
    onCloseHeld: () -> Unit,
    empty: String? = null,
) {
    ChipFlow(Modifier.testTag(tag)) {
        if (chips.isEmpty() && empty != null) HintText(empty)
        chips.forEach { item ->
            TopicChip(
                item.topic.label,
                item.count,
                on = item.topic.topicId in chosen,
                disabled = disabled,
                onToggle = { onToggle(item.topic) },
                onHold = { onHold(HeldChip(item.topic, group)) },
            )
        }
        if (held != null && held.group == group) ChipActionBar(held.topic, onFind = { onFind(held.topic) }, onClose = onCloseHeld)
    }
}

/**
 * .pp-chips: chips that wrap, 8 dp apart, read as one group. The web names each group for screen
 * readers ("Chosen topics", "Common topics"); a name on a container here would hide its chips from
 * VoiceOver, so the subheads above the groups carry the meaning instead.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChipFlow(modifier: Modifier = Modifier, content: @Composable FlowRowScope.() -> Unit) {
    FlowRow(
        modifier.fillMaxWidth().semantics { isTraversalGroup = true },
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        itemVerticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}

/**
 * .pp-chip: a 44 dp pill with Plus (off) or Check (on), the label (cut with an ellipsis) and, for
 * a listed topic, its talk count, which stays when the chip is on so the chip keeps its width. On, it
 * fills with the accent. A tap toggles it; a long press opens its action. Screen readers hear
 * "{label}, {n} talks" and the pressed state. A [disabled] chip that is off fades and does nothing.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TopicChip(
    label: String,
    count: Int?,
    on: Boolean,
    disabled: Boolean,
    onToggle: () -> Unit,
    onHold: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = Caddie.colors
    val enabled = on || !disabled
    val bg by animateColorAsState(if (on) c.accent else c.surface, tween(MOTION_MS))
    val interaction = remember { MutableInteractionSource() }
    Row(
        modifier
            .minimumInteractiveComponentSize()
            .heightIn(min = Caddie.dimens.minTouch)
            .alpha(if (enabled) 1f else 0.45f)
            .focusRing(interaction, Pill)
            .clip(Pill)
            .background(bg)
            // The border goes transparent when on, so the chip keeps its size.
            .border(1.dp, if (on) bg else c.borderStrong, Pill)
            .combinedClickable(
                interactionSource = interaction,
                indication = ripple(),
                enabled = enabled,
                role = Role.Switch,
                onLongClickLabel = ProfileStrings.FIND_PEOPLE_DONE,
                onLongClick = onHold,
                onClick = onToggle,
            )
            .semantics {
                contentDescription = ProfileStrings.chipName(label, count)
                toggleableState = ToggleableState(on)
            }
            .padding(start = 10.dp, end = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        val fg = if (on) c.onAccent else c.text
        LucideImage(if (on) LucideIcon.Check else LucideIcon.Plus, null, size = 16.dp, tint = if (on) c.onAccent else c.text2)
        Text(
            label,
            style = Caddie.type.stateBody.copy(fontWeight = FontWeight.Medium),
            color = fg,
            // The web keeps a chip on one line; two lines here keep a long label readable at large
            // system font sizes before the ellipsis cuts it.
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false).clearAndSetSemantics { },
        )
        if (count != null) {
            Text(
                count.toString(),
                style = Caddie.type.tag.copy(fontFeatureSettings = "tnum"),
                color = if (on) c.onAccent.copy(alpha = c.onAccent.alpha * 0.85f) else c.text2,
                maxLines = 1,
                modifier = Modifier.clearAndSetSemantics { },
            )
        }
    }
}

/**
 * .pp-chip-action: under a long-pressed chip's group, across the whole row: "Find people who've
 * done this" (tonal), the topic's label, and Close.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChipActionBar(topic: TopicRef, onFind: () -> Unit, onClose: () -> Unit) {
    val c = Caddie.colors
    FlowRow(
        Modifier
            .fillMaxWidth()
            .background(c.accentTint, RoundedCornerShape(10.dp))
            .semantics { isTraversalGroup = true }
            .testTag("topic-action")
            .padding(start = 10.dp, top = 6.dp, end = 4.dp, bottom = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
        itemVerticalAlignment = Alignment.CenterVertically,
    ) {
        CaddieButton(ProfileStrings.FIND_PEOPLE_DONE, onFind, variant = ButtonVariant.Tonal, small = true, icon = LucideIcon.Users)
        // The label takes what is left of the line and is cut with an ellipsis, as on the web.
        Text(
            topic.label,
            style = Caddie.type.meta,
            color = c.text2,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f).semantics { contentDescription = ProfileStrings.actionsFor(topic.label) },
        )
        CaddieIconButton(LucideIcon.X, Strings.Common.CLOSE, onClose, iconSize = 18.dp)
    }
}

/**
 * .pp-field.pp-topic-search: a 44 dp pill on the fill colour with an 18 dp search icon, "Find a
 * topic", at most 60 characters, the 2 dp accent ring while focused and Clear once there is text.
 * [label] names it for screen readers.
 */
@Composable
private fun TopicSearchField(value: String, onValueChange: (String) -> Unit, label: String, modifier: Modifier = Modifier, fieldTag: String) {
    val c = Caddie.colors
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val focusManager = LocalFocusManager.current
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = Caddie.dimens.minTouch)
            .clip(Pill)
            .background(c.fill)
            .then(if (focused) Modifier.border(2.dp, c.accent, Pill) else Modifier),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        LucideImage(LucideIcon.Search, null, Modifier.padding(start = 14.dp), size = 18.dp)
        Box(Modifier.weight(1f).padding(start = 10.dp, end = 8.dp), contentAlignment = Alignment.CenterStart) {
            if (value.isEmpty()) Text(ProfileStrings.FIND_TOPIC, style = Caddie.type.body, color = c.text2, maxLines = 1, modifier = Modifier.clearAndSetSemantics { })
            BasicTextField(
                value = value,
                onValueChange = { onValueChange(it.take(60)) },
                singleLine = true,
                textStyle = Caddie.type.body.copy(color = c.text),
                cursorBrush = SolidColor(c.accent),
                interactionSource = interaction,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { focusManager.clearFocus() }),
                modifier = Modifier.fillMaxWidth().testTag(fieldTag).semantics { contentDescription = label },
            )
        }
        if (value.isNotEmpty()) CaddieIconButton(LucideIcon.X, ProfileStrings.CLEAR, { onValueChange("") }, iconSize = 18.dp)
    }
}
