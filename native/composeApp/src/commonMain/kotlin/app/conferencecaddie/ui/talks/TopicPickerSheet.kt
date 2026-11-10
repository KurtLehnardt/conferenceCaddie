package app.conferencecaddie.ui.talks

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.conferencecaddie.shared.bundle.TalkBundle
import app.conferencecaddie.shared.bundle.Topic
import app.conferencecaddie.shared.search.TopicSearch
import app.conferencecaddie.ui.components.ButtonVariant
import app.conferencecaddie.ui.components.CaddieButton
import app.conferencecaddie.ui.components.CaddieSheet
import app.conferencecaddie.ui.components.LabelledTextField
import app.conferencecaddie.ui.components.PillSearchField
import app.conferencecaddie.ui.components.TopicChip
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie
import kotlinx.coroutines.delay

/**
 * What the person wants to learn, in a sheet: the web's topic picker (web/src/people/TopicPicker.tsx)
 * for "I want to learn about", over the bundle's topics, and the text field "What I'm trying to learn
 * or figure out next" (web/src/people/ProfileScreen.tsx). On the web both live in the profile; the
 * native apps have no profile on a backend without people features, so For you opens them here.
 *
 * As on the web: chosen topics are pinned on top and a removed one stays there, unselected, until
 * taps pause, so no chip moves under the finger; then type-ahead results, "Suggested for you" (from
 * the marked talks and the text), and the common topics with "Show more". At most 30 topics.
 * Every change is saved at once through [onTopics] and [onText].
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TopicPickerSheet(
    bundle: TalkBundle,
    selected: List<String>,
    text: String,
    interested: List<String>,
    onTopics: (List<String>) -> Unit,
    onText: (String) -> Unit,
    onClose: () -> Unit,
) {
    val c = Caddie.colors
    val title = Strings.Topics.LEARN_TITLE
    var query by rememberSaveable { mutableStateOf("") }
    var showAll by rememberSaveable { mutableStateOf(false) }
    var draft by rememberSaveable { mutableStateOf(text) }
    // The pinned row in display order, ghosts (just removed) included.
    val pinned = remember { mutableStateListOf<String>().apply { addAll(selected) } }
    var ghostTick by remember { mutableStateOf(0) }
    val chosen = selected.toSet()
    val full = selected.size >= Strings.Topics.MAX
    val latestChosen by rememberUpdatedState(chosen)

    LaunchedEffect(ghostTick) {
        if (ghostTick == 0) return@LaunchedEffect
        delay(GHOST_MS)
        pinned.retainAll(latestChosen)
    }
    // A topic chosen from a list joins the pinned row at the end.
    LaunchedEffect(selected) { for (id in selected) if (id !in pinned) pinned += id }

    fun toggle(id: String) {
        if (id in chosen) {
            onTopics(selected - id)
            ghostTick++
        } else if (!full) {
            onTopics(selected + id)
            if (id !in pinned) pinned += id
            // Every tap restarts the pause, so the pinned row settles only once taps stop.
            if (pinned.any { it !in chosen && it != id }) ghostTick++
        }
    }

    val byId = bundle.topicsById
    val hits = if (query.isBlank()) null else TopicSearch.typeAhead(bundle, query)
    val suggested = remember(interested, draft, bundle.contentHash) { TopicSearch.suggest(bundle, interested, draft) }
    val common = remember(bundle.contentHash) { TopicSearch.common(bundle) }

    CaddieSheet(
        title = title,
        onClose = onClose,
        modifier = Modifier.testTag("topic-sheet"),
        footer = {
            Text(Strings.Topics.count(selected.size), style = Caddie.type.note, color = c.text2, modifier = Modifier.weight(1f).testTag("topic-count"))
            CaddieButton(Strings.Topics.DONE, onClick = onClose, small = true, modifier = Modifier.testTag("topic-done"))
        },
    ) {
        Column(Modifier.fillMaxWidth().padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (pinned.isNotEmpty()) {
                ChipGroup(Strings.Topics.CHOSEN, Modifier.testTag("topic-chosen")) {
                    pinned.forEach { id ->
                        val t = byId[id] ?: return@forEach
                        TopicChip(t.label, id in chosen, { toggle(id) }, count = t.talkCount)
                    }
                }
            }
            PillSearchField(
                value = query,
                onValueChange = { query = it },
                placeholder = Strings.Topics.FIND,
                label = Strings.Topics.findLabel(title),
                modifier = Modifier.testTag("topic-find"),
            )
            if (hits != null) {
                ChipGroup(Strings.Topics.MATCHING, Modifier.testTag("topic-hits")) {
                    if (hits.isEmpty()) Text(Strings.Topics.NO_MATCH, style = Caddie.type.meta, color = c.text2)
                    hits.forEach { TopicChipFor(it, chosen, full, ::toggle) }
                }
            } else {
                if (suggested.isNotEmpty()) {
                    Subhead(Strings.Topics.SUGGESTED)
                    ChipGroup(Strings.Topics.SUGGESTED_GROUP, Modifier.testTag("topic-suggested")) {
                        suggested.forEach { TopicChipFor(it, chosen, full, ::toggle) }
                    }
                }
                Subhead(Strings.Topics.COMMON)
                ChipGroup(Strings.Topics.COMMON_GROUP, Modifier.testTag("topic-common")) {
                    (if (showAll) common else common.take(FIRST)).forEach { TopicChipFor(it, chosen, full, ::toggle) }
                }
                if (common.size > FIRST) {
                    CaddieButton(
                        if (showAll) Strings.Topics.SHOW_FEWER else Strings.Topics.showMore(common.size - FIRST),
                        onClick = { showAll = !showAll },
                        variant = ButtonVariant.Text,
                        small = true,
                        modifier = Modifier.padding(start = 0.dp).testTag("topic-more"),
                    )
                }
            }
            if (full) Text(Strings.Topics.FULL, style = Caddie.type.meta, color = c.text2)
            LabelledTextField(
                label = Strings.Topics.TEXT_LABEL,
                value = draft,
                onValueChange = {
                    draft = it
                    onText(it)
                },
                maxLength = 500,
                placeholder = Strings.Topics.TEXT_PLACEHOLDER,
                hint = Strings.Topics.SPECIFIC_HINT,
                modifier = Modifier.padding(top = 10.dp).testTag("learn-text"),
            )
        }
    }
}

@Composable
private fun TopicChipFor(topic: Topic, chosen: Set<String>, full: Boolean, toggle: (String) -> Unit) {
    TopicChip(topic.label, topic.topicId in chosen, { toggle(topic.topicId) }, count = topic.talkCount, enabled = !full)
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChipGroup(label: String, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    FlowRow(
        modifier.fillMaxWidth().semantics { contentDescription = label },
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        itemVerticalAlignment = Alignment.CenterVertically,
    ) { content() }
}

/** .pp-subhead: a small uppercase heading over a chip group. */
@Composable
private fun Subhead(text: String) {
    Row(Modifier.padding(top = 4.dp)) {
        Text(
            text.uppercase(),
            style = Caddie.type.sectionHeading.copy(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
            color = Caddie.colors.text2,
        )
    }
}

private const val FIRST = 12
private const val GHOST_MS = 1200L
