package app.conferencecaddie.ui.talks

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import app.conferencecaddie.shared.bundle.Talk
import app.conferencecaddie.shared.bundle.TalkBundle
import app.conferencecaddie.shared.bundle.TalkTime
import app.conferencecaddie.shared.search.ForYou
import app.conferencecaddie.ui.components.ButtonVariant
import app.conferencecaddie.ui.components.CaddieButton
import app.conferencecaddie.ui.components.LinkButton
import app.conferencecaddie.ui.components.LucideImage
import app.conferencecaddie.ui.components.ProgressBar
import app.conferencecaddie.ui.components.caddieClickable
import app.conferencecaddie.ui.components.textIconSize
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.shell.isWebLink
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * For you's state, kept outside the composables like [SearchModel], so the list survives tab
 * switches. [refresh] asks the shared core again whenever an input changes (the conference, the
 * learn topics and text, the marked talks, whether the model is loaded, the minute), after a short
 * pause as the web waits before asking the server. While a new answer is on its way the earlier list
 * stays and [refreshing] is true, so it can be dimmed, as on the web. If working one out fails, the
 * earlier list stays too and [error] says so, as the web does when the server fails; the next
 * refresh tries again.
 */
class ForYouModel(
    private val scope: CoroutineScope,
    private val run: suspend () -> ForYou.Result?,
) {
    var result by mutableStateOf<ForYou.Result?>(null)
        private set

    var refreshing by mutableStateOf(false)
        private set

    /** Why the last refresh has no answer ([Strings.ForYou.ERROR]), or null. */
    var error by mutableStateOf<String?>(null)
        private set

    private var key: Any? = null
    private var slug: String? = null
    private var job: Job? = null

    fun refresh(newSlug: String?, inputs: Any) {
        val next = newSlug to inputs
        if (next == key) return
        if (newSlug != slug) {
            result = null
            error = null
        }
        slug = newSlug
        key = next
        job?.cancel()
        refreshing = result != null || error != null
        job = scope.launch {
            delay(if (result == null && error == null) 0L else DELAY_MS)
            try {
                val answer = run()
                result = answer
                error = null
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // The same inputs are asked again once anything changes, the minute included.
                error = Strings.ForYou.ERROR
                key = null
            }
            refreshing = false
        }
    }

    companion object {
        const val DELAY_MS = 400L
        const val SIZE = 20
    }
}

/**
 * The For you tab (web ForYouScreen in web/src/people/ForYou.tsx): the lede, then a card per
 * suggested talk with why it was picked, the "I'm interested" button and the official link. With
 * nothing to go on, the web's "Pick what you want to learn" prompt. Everything runs on the device,
 * so it also works offline. A card opens the talk in the talk sheet; [onPickTopics] opens the topic
 * picker.
 */
@Composable
fun ForYouScreen(
    model: ForYouModel,
    bundle: TalkBundle,
    learnTopics: List<String>,
    interested: Set<String>,
    onToggleInterested: (Talk) -> Unit,
    onOpenTalk: (Talk) -> Unit,
    onOpenUrl: (String) -> Unit,
    onPickTopics: () -> Unit,
) {
    val d = Caddie.dimens
    when (val r = model.result) {
        ForYou.Result.NeedsInput -> Column(Modifier.fillMaxSize().padding(start = d.gutter, end = d.gutter, top = 4.dp).testTag("for-you-screen")) {
            PickTopicsPrompt(onPickTopics)
        }
        else -> LazyColumn(
            Modifier.fillMaxSize().testTag("for-you-screen"),
            contentPadding = PaddingValues(start = d.gutter, end = d.gutter, top = 4.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item("lede") {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(Strings.ForYou.LEDE_NATIVE, style = Caddie.type.stateBody, color = Caddie.colors.text2)
                    LearnSummary(bundle, learnTopics, onPickTopics)
                    ProgressBar(model.refreshing || (r == null && model.error == null))
                }
            }
            model.error?.let { message ->
                item("error") {
                    Text(
                        message,
                        style = Caddie.type.meta,
                        color = Caddie.colors.danger,
                        modifier = Modifier.padding(vertical = 8.dp).testTag("for-you-error").semantics { liveRegion = LiveRegionMode.Polite },
                    )
                }
            }
            when (r) {
                null -> if (model.error == null) item("finding") { Hint(Strings.ForYou.FINDING) }
                is ForYou.Result.Ready -> {
                    if (r.degraded) item("degraded") { Hint(Strings.ForYou.DEGRADED_NATIVE, Modifier.semantics { liveRegion = LiveRegionMode.Polite }) }
                    if (r.items.isEmpty()) item("none") { Hint(Strings.ForYou.NONE) }
                    items(r.items, key = { it.talk.talkId }) { item ->
                        ForYouCard(
                            item = item,
                            interested = item.talk.talkId in interested,
                            dimmed = model.refreshing,
                            onToggleInterested = { onToggleInterested(item.talk) },
                            onOpen = { onOpenTalk(item.talk) },
                            onOpenUrl = onOpenUrl,
                        )
                    }
                }
                ForYou.Result.NeedsInput -> Unit
            }
        }
    }
}

@Composable
private fun Hint(text: String, modifier: Modifier = Modifier) {
    Text(text, style = Caddie.type.meta, color = Caddie.colors.text2, modifier = modifier.padding(vertical = 8.dp))
}

/** The chosen learn topics in one line and the button that opens the picker (native only). */
@Composable
private fun LearnSummary(bundle: TalkBundle, learnTopics: List<String>, onPickTopics: () -> Unit) {
    val labels = learnTopics.mapNotNull { bundle.topicsById[it]?.label }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (labels.isNotEmpty()) WhyLine(Strings.ForYou.WHY_LABEL, labels.joinToString(", "), Modifier.testTag("for-you-topics"))
        CaddieButton(
            Strings.ForYou.PICK_TOPICS,
            onClick = onPickTopics,
            variant = ButtonVariant.Tonal,
            small = true,
            icon = LucideIcon.SlidersHorizontal,
            iconSize = 16.dp,
            modifier = Modifier.testTag("for-you-pick"),
        )
    }
}

/** .pp-prompt: the card that asks for something to suggest from. */
@Composable
fun PickTopicsPrompt(onPickTopics: () -> Unit, modifier: Modifier = Modifier) {
    val c = Caddie.colors
    val shape = RoundedCornerShape(Caddie.dimens.radius)
    Row(
        modifier.fillMaxWidth().background(c.surface, shape).border(1.dp, c.border, shape).padding(16.dp).testTag("for-you-prompt"),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        LucideImage(LucideIcon.Sparkles, null, Modifier.padding(top = 2.dp), size = textIconSize(22.dp), tint = c.accent)
        Column(Modifier.weight(1f)) {
            // .pp-prompt-title is 17 px semibold at the page's line height (1.45), which with the
            // body's 4 px top margin makes the web's gap; cardTitle's tighter 1.3 would close it up.
            Text(Strings.ForYou.PICK_TITLE, style = Caddie.type.stateTitle, color = c.text, modifier = Modifier.semantics { heading() })
            Text(Strings.ForYou.PICK_BODY_NATIVE, style = Caddie.type.stateBody, color = c.text2, modifier = Modifier.padding(top = 4.dp))
            CaddieButton(Strings.ForYou.PICK_TOPICS, onClick = onPickTopics, small = true, modifier = Modifier.padding(top = 12.dp).testTag("for-you-prompt-pick"))
        }
    }
}

@Composable
private fun WhyLine(label: String, value: String, modifier: Modifier = Modifier) {
    val text = buildAnnotatedString {
        withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(label) }
        append(" ")
        append(value)
    }
    Text(text, style = Caddie.type.meta, color = Caddie.colors.text, modifier = modifier)
}

/** .pp-talk-card: one suggestion. */
@Composable
private fun ForYouCard(
    item: ForYou.Item,
    interested: Boolean,
    dimmed: Boolean,
    onToggleInterested: () -> Unit,
    onOpen: () -> Unit,
    onOpenUrl: (String) -> Unit,
) {
    val c = Caddie.colors
    val t = item.talk
    val shape = RoundedCornerShape(Caddie.dimens.radius)
    Column(
        Modifier
            .fillMaxWidth()
            .alpha(if (dimmed) 0.55f else 1f)
            .then(if (c.cardShadow) Modifier.shadow(1.dp, shape, ambientColor = c.border, spotColor = c.border) else Modifier)
            .background(c.surface, shape)
            .border(1.dp, c.border, shape)
            .caddieClickable(shape, onClick = onOpen)
            .padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 6.dp)
            .testTag("for-you-${t.talkId}"),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(t.title, style = Caddie.type.cardTitle, color = c.text, modifier = Modifier.semantics { heading() })
        if (t.speakers.isNotEmpty()) Text(t.speakers.joinToString(", "), style = Caddie.type.meta, color = c.text2)
        Text(
            "${TalkTime.day(t.day)} · ${TalkTime.time(t.startMinutes)}" + (t.room?.let { " · $it" } ?: ""),
            style = Caddie.type.meta,
            color = c.text2,
        )
        if (item.learnTopics.isNotEmpty()) WhyLine(Strings.ForYou.WHY_LABEL, item.learnTopics.joinToString(", "))
        item.like?.let { WhyLine(Strings.ForYou.LIKE_LABEL, it.title) }
        item.passage?.let {
            Text(it, style = Caddie.type.meta, color = c.text2, maxLines = 3, overflow = TextOverflow.Ellipsis)
        }
        Row(Modifier.padding(top = 4.dp)) {
            CaddieButton(
                if (interested) Strings.ForYou.INTERESTED_ON else Strings.Talk.INTERESTED,
                onClick = onToggleInterested,
                variant = if (interested) ButtonVariant.Primary else ButtonVariant.Tonal,
                small = true,
                icon = LucideIcon.Star,
                iconFilled = interested,
                iconSize = 16.dp,
                modifier = Modifier.testTag("for-you-interested-${t.talkId}"),
            )
        }
        t.url?.takeIf { isWebLink(it) }?.let { url ->
            LinkButton(Strings.Talk.ADD_ON_OFFICIAL, LucideIcon.ExternalLink) { onOpenUrl(url) }
        }
    }
}

