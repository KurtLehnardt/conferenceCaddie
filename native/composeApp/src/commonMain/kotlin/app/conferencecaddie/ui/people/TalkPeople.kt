package app.conferencecaddie.ui.people

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import app.conferencecaddie.shared.bundle.TalkTime
import app.conferencecaddie.shared.people.ApiResult
import app.conferencecaddie.shared.people.CircleMembersResponse
import app.conferencecaddie.shared.people.PeopleController
import app.conferencecaddie.shared.people.PeopleError
import app.conferencecaddie.shared.people.PeopleText
import app.conferencecaddie.shared.people.PeopleUiState
import app.conferencecaddie.shared.people.SpeakerProfile
import app.conferencecaddie.ui.components.ButtonVariant
import app.conferencecaddie.ui.components.CaddieButton
import app.conferencecaddie.ui.components.LinkButton
import app.conferencecaddie.ui.components.LucideImage
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.theme.Caddie
import kotlin.math.min
import kotlinx.coroutines.launch

// The talk circles (web TalkPeopleControls.tsx and ShareAllControls.tsx, spec section 13) and the
// ended-talk banner (web PeopleScreen.tsx EndedTalkBanner, spec section 3). The web has no flag for
// circles; the native apps hide all three without `people.circles`, the capability that offers them.

/** The most talks a profile can be shared for, as the server allows. */
private const val MAX_SHARED_TALKS = 50

/**
 * A talk's people controls (web TalkPeopleControls.tsx, spec section 13), at the foot of the talk
 * sheet's card (TalkSheet's `peopleControls` slot) and inside [EndedTalkBanner]. The People layer
 * draws it only online and with people features on; offline the sheet shows "Talk circles need a
 * connection." for an Interested talk instead.
 *
 * Renders nothing unless [interested], or the talk is shared (`talkId in
 * state.visibility.sharedTalkIds`), or someone shares for it. Then: the count ("1 person wants to
 * talk about this", from `controller.circleCounts(listOf(talkId))`); the switch "Share my profile
 * with others interested in this talk" (`controller.shareForTalk(talkId, on)`; the first time,
 * `PeopleText.SHARE_NOTICE` asks first, and a successful share marks it seen); and, once shared,
 * "See who's here", which opens the circle (`controller.circleMembers(talkId)`: speakers, then
 * [SampleNote] and U2's [PersonCard] per member). [startOpen] opens the circle at once (the ended-talk
 * banner's "See who else was interested").
 */
@Composable
fun TalkPeopleControls(
    talkId: String,
    interested: Boolean,
    state: PeopleUiState,
    host: PeopleHost,
    modifier: Modifier = Modifier,
    startOpen: Boolean = false,
) {
    TalkPeopleBody(talkId, interested, state, host, modifier, startOpen, inBanner = false)
}

/**
 * The controls of [TalkPeopleControls]. [inBanner] is `.pp-banner .pp-talk`: no rule or space above,
 * and 8 dp in from the banner's right edge.
 */
@Composable
private fun TalkPeopleBody(
    talkId: String,
    interested: Boolean,
    state: PeopleUiState,
    host: PeopleHost,
    modifier: Modifier,
    startOpen: Boolean,
    inBanner: Boolean,
) {
    if (!state.features.circles) return
    val controller = host.controller
    val scope = rememberCoroutineScope()
    val vis = state.visibility
    val shared = talkId in vis.sharedTalkIds
    var refresh by remember(talkId) { mutableIntStateOf(0) }
    var count by remember(talkId) { mutableStateOf<Int?>(null) }
    var notice by remember(talkId) { mutableStateOf(false) }
    var busy by remember(talkId) { mutableStateOf(false) }
    var message by remember(talkId) { mutableStateOf<String?>(null) }
    var open by rememberSaveable(talkId) { mutableStateOf(startOpen) }

    // The count is cached by the controller for a minute and dropped when this device's share changes.
    LaunchedEffect(controller, talkId, shared, refresh) {
        controller.circleCounts(listOf(talkId))[talkId]?.let { count = it }
    }

    fun apply(on: Boolean) {
        val others = vis.sharedTalkIds.filter { it != talkId }
        if (on && others.size >= MAX_SHARED_TALKS) {
            message = ProfileStrings.SHARE_LIMIT
            return
        }
        scope.launch {
            busy = true
            message = null
            val err = controller.shareForTalk(talkId, on)
            busy = false
            notice = false
            if (err != null) {
                message = err
            } else {
                refresh++
                if (!on) open = false
            }
        }
    }

    fun onSwitch(on: Boolean) {
        if (on && !vis.shareNoticeSeen) notice = true else apply(on)
    }

    val showToggle = interested || shared
    val n = count ?: 0
    if (!showToggle && n <= 0) return

    val c = Caddie.colors
    Column(
        modifier
            .fillMaxWidth()
            .then(
                if (inBanner) {
                    Modifier.padding(end = 8.dp)
                } else {
                    // .pp-talk: 8 dp above, a 1 dp rule, 8 dp below it.
                    Modifier.padding(top = 8.dp)
                        .drawBehind { drawRect(c.border, size = Size(size.width, 1.dp.toPx())) }
                        .padding(top = 9.dp)
                },
            )
            .semantics { isTraversalGroup = true }
            .testTag("talk-people-$talkId"),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (n > 0) CountLine(PeopleText.peopleCountLabel(n), Modifier.testTag("circle-count-$talkId"))
        if (showToggle) {
            PeopleSwitchRow(
                ProfileStrings.SHARE_FOR_TALK,
                checked = shared,
                onChange = ::onSwitch,
                enabled = !busy,
                modifier = Modifier.testTag("share-switch-$talkId"),
            )
        }
        if (notice) ShareNotice(busy, onShare = { apply(true) }, onNotNow = { notice = false })
        message?.let { m ->
            if (m.contains("profile")) MessageWithLink(m, PeopleCommonStrings.OPEN_MY_PROFILE, host::openProfile) else ErrorText(m)
        }
        if (shared) {
            // "See who's here": the chevron after the label, up while the circle is open; screen
            // readers hear whether it is expanded.
            CaddieButton(
                ProfileStrings.SEE_WHOS_HERE,
                { open = !open },
                Modifier
                    .testTag("see-who-$talkId")
                    .semantics { stateDescription = if (open) ProfileStrings.EXPANDED else ProfileStrings.COLLAPSED },
                variant = ButtonVariant.Tonal,
                small = true,
                trailingIcon = if (open) LucideIcon.ChevronUp else LucideIcon.ChevronDown,
            )
        }
        if (shared && open) CircleView(talkId, state, host)
    }
}

/** .pp-count: the people icon and [text] in the accent ink, 14/600. */
@Composable
private fun CountLine(text: String, modifier: Modifier = Modifier) {
    val c = Caddie.colors
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        LucideImage(LucideIcon.Users, null, size = 16.dp, tint = c.accentInk)
        Text(text, style = Caddie.type.peopleLabel, color = c.accentInk, modifier = Modifier.weight(1f, fill = false))
    }
}

/** The sharing notice (`PeopleText.SHARE_NOTICE`) with "Share my profile" and "Not now". */
@Composable
private fun ShareNotice(busy: Boolean, onShare: () -> Unit, onNotNow: () -> Unit) {
    PeopleNotice(Modifier.semantics { isTraversalGroup = true }.testTag("share-notice")) {
        Text(PeopleText.SHARE_NOTICE)
        ActionsRow {
            CaddieButton(ProfileStrings.SHARE_MY_PROFILE, onShare, variant = ButtonVariant.Primary, small = true, enabled = !busy)
            CaddieButton(ProfileStrings.NOT_NOW, onNotNow, variant = ButtonVariant.Text, small = true)
        }
    }
}

/** What the circle of a talk shows. */
private sealed interface CircleLoad {
    data object Loading : CircleLoad

    /** The device does not share for the talk (share_required, or no device yet). */
    data object NeedsShare : CircleLoad

    data class Failed(val message: String) : CircleLoad

    data class Loaded(val circle: CircleMembersResponse) : CircleLoad
}

/**
 * CircleView: who else shares for [talkId], read again after every profile save. "Loading…"; "Share
 * your profile for this talk to see who else is interested." when the server says the device does
 * not share; the failure line; else the speakers (name, tagline, up to four http(s) links) and
 * "Others who shared" with [SampleNote] and U2's [PersonCard]s, blocked people left out.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CircleView(talkId: String, state: PeopleUiState, host: PeopleHost) {
    var load by remember(talkId) { mutableStateOf<CircleLoad>(CircleLoad.Loading) }
    LaunchedEffect(host.controller, talkId, state.saveCount) {
        load = when (val r = host.controller.circleMembers(talkId)) {
            is ApiResult.Ok -> CircleLoad.Loaded(r.value)
            is ApiResult.Failed -> when (r.error.kind) {
                PeopleError.Kind.ShareRequired, PeopleError.Kind.NoDevice -> CircleLoad.NeedsShare
                // The web shows its own line when the request never reached the server.
                PeopleError.Kind.Offline -> CircleLoad.Failed(ProfileStrings.CIRCLE_UNAVAILABLE)
                else -> CircleLoad.Failed(r.error.message)
            }
        }
    }
    when (val l = load) {
        CircleLoad.Loading -> HintText(ProfileStrings.LOADING)
        CircleLoad.NeedsShare -> HintText(ProfileStrings.NEEDS_SHARE)
        is CircleLoad.Failed -> ErrorText(l.message)
        is CircleLoad.Loaded -> Column(
            Modifier.fillMaxWidth().padding(top = 4.dp).testTag("circle-$talkId"),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            val speakers = l.circle.speakers
            if (speakers.isNotEmpty()) {
                Subhead(ProfileStrings.SPEAKERS)
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) { speakers.forEach { SpeakerRow(it, host) } }
            }
            Subhead(ProfileStrings.OTHERS_WHO_SHARED)
            val blocked = state.blocks.map { it.ref }.toSet()
            val members = l.circle.members.filter { it.ref !in blocked }
            if (members.isEmpty()) {
                HintText(ProfileStrings.NO_ONE_SHARED)
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    SampleNote(members)
                    members.forEach { person -> key(person.ref) { PersonCard(person, state, host) } }
                }
            }
        }
    }
}

private val HTTP_LINK = Regex("^https?://")

/** .pp-speaker: a speaker on the fill colour, radius 10: name (600), tagline, and up to four links. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SpeakerRow(speaker: SpeakerProfile, host: PeopleHost) {
    val c = Caddie.colors
    Column(
        Modifier.fillMaxWidth().background(c.fill, RoundedCornerShape(10.dp)).padding(horizontal = 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(speaker.name, style = Caddie.type.body.copy(fontWeight = FontWeight.SemiBold), color = c.text)
        speaker.tagline?.takeIf { it.isNotBlank() }?.let { Text(it, style = Caddie.type.meta, color = c.text2) }
        val links = speaker.links.filter { HTTP_LINK.containsMatchIn(it.url) }.take(4)
        if (links.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                links.forEach { link -> LinkButton(link.title.ifBlank { ProfileStrings.LINK }, LucideIcon.ExternalLink) { host.openUrl(link.url) } }
            }
        }
    }
}

/** Which action the sharing notice of [ShareAllControls] is asking about. */
private enum class ShareAllNotice { ShareAll, Follow }

/**
 * ShareAllControls (web ShareAllControls.tsx, spec section 13): a card at the top of the Interested
 * list, "Share with people interested in these talks", for the listed [talkIds]: the summary line,
 * "Share for this talk" / "Share for all {n}" (`controller.shareForTalks(ids)`, at most 50), "Stop
 * sharing for all" (`controller.unshareAll()`), the switch "Share automatically for talks I mark,
 * and stop when I unmark" (`controller.followInterested()` / `stopFollowingInterested()`,
 * `state.visibility.shareNew`) and the sharing notice the first time. The People layer draws it only
 * online with people features on; it draws nothing for an empty list.
 */
@Composable
fun ShareAllControls(talkIds: List<String>, state: PeopleUiState, host: PeopleHost, modifier: Modifier = Modifier) {
    if (!state.features.circles || talkIds.isEmpty()) return
    val controller = host.controller
    val scope = rememberCoroutineScope()
    val vis = state.visibility
    val sharedHere = talkIds.count { it in vis.sharedTalkIds }
    val allShared = sharedHere == talkIds.size
    var busy by remember { mutableStateOf(false) }
    var notice by remember { mutableStateOf<ShareAllNotice?>(null) }
    var message by remember { mutableStateOf<String?>(null) }

    fun run(action: suspend () -> String?) {
        scope.launch {
            busy = true
            message = null
            val err = action()
            busy = false
            notice = null
            if (err != null) message = err
        }
    }

    fun shareAll() = run { controller.shareForTalks(talkIds) }

    // Turning the switch on also shares for everything already marked. The preference is stored only
    // when that succeeds, so the switch stays off and the message says why.
    fun followOn() = run { controller.followInterested() }

    fun onFollow(on: Boolean) {
        when {
            !on -> scope.launch { controller.stopFollowingInterested() }
            vis.shareNoticeSeen -> followOn()
            else -> notice = ShareAllNotice.Follow
        }
    }

    PeopleCard(modifier.testTag("share-all"), title = ProfileStrings.SHARE_ALL_TITLE) {
        CountLine(ProfileStrings.shareSummary(sharedHere, talkIds.size), Modifier.testTag("share-all-summary"))
        if (!allShared || vis.sharedTalkIds.isNotEmpty()) {
            ActionsRow {
                if (!allShared) {
                    CaddieButton(
                        if (talkIds.size == 1) ProfileStrings.SHARE_FOR_THIS_TALK else ProfileStrings.shareForAll(min(talkIds.size, MAX_SHARED_TALKS)),
                        { if (vis.shareNoticeSeen) shareAll() else notice = ShareAllNotice.ShareAll },
                        Modifier.testTag("share-all-button"),
                        variant = ButtonVariant.Primary,
                        small = true,
                        enabled = !busy,
                    )
                }
                if (vis.sharedTalkIds.isNotEmpty()) {
                    CaddieButton(
                        ProfileStrings.STOP_SHARING_ALL,
                        { run { controller.unshareAll() } },
                        Modifier.testTag("share-all-stop"),
                        variant = ButtonVariant.Text,
                        small = true,
                        enabled = !busy,
                    )
                }
            }
        }
        PeopleSwitchRow(
            ProfileStrings.SHARE_AUTOMATICALLY,
            checked = vis.shareNew,
            onChange = ::onFollow,
            enabled = !busy,
            modifier = Modifier.testTag("share-follow"),
        )
        notice?.let { which ->
            ShareNotice(busy, onShare = { if (which == ShareAllNotice.ShareAll) shareAll() else followOn() }, onNotNow = { notice = null })
        }
        message?.let { m ->
            // The 50-talk cut and retired topics report something done for the user: a hint, not an error.
            val hint = PeopleController.isHintMessage(m)
            when {
                m.contains("profile") -> MessageWithLink(m, PeopleCommonStrings.OPEN_MY_PROFILE, host::openProfile, error = !hint)
                hint -> HintText(m, Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                else -> ErrorText(m)
            }
        }
    }
}

/**
 * EndedTalkBanner (web PeopleScreen.tsx, spec section 3), on the People home while not searching:
 * for the most recent Interested talk (`talks.interested`, `talks.bundle`) that has ended
 * (`talks.nowMs`) and is not in `state.visibility.bannerSeen`, the accent banner (MessagesSquare)
 * "Want to keep talking about **{title}**? See who else was interested." with Close
 * (`controller.markBannerSeen(id)`), "See who else was interested" (marks it seen and shows
 * [TalkPeopleControls] with `startOpen = true` in place of the actions, keeping the talk shown) and
 * "Open talk" (`host.openTalk(id)`). U2's [PeopleScreen] draws it.
 */
@Composable
fun EndedTalkBanner(talks: PeopleTalks, state: PeopleUiState, host: PeopleHost, modifier: Modifier = Modifier) {
    if (!state.features.circles) return
    val bundle = talks.bundle ?: return
    val scope = rememberCoroutineScope()
    var open by remember { mutableStateOf(false) }
    // The talk the user opened stays, even once it is marked as seen; one of another conference's
    // bundle is not found and is ignored.
    var pinned by remember { mutableStateOf<String?>(null) }
    val seen = state.visibility.bannerSeen
    val ended = talks.interested
        .mapNotNull { bundle.talksById[it] }
        .filter { TalkTime.hasEnded(it, talks.nowMs) && it.talkId !in seen }
        .sortedByDescending { it.endEpochMs }
    val talk = pinned?.let { bundle.talksById[it] } ?: ended.firstOrNull() ?: return

    PeopleBanner(
        LucideIcon.MessagesSquare,
        modifier.testTag("ended-talk-banner").semantics { isTraversalGroup = true },
        onClose = {
            scope.launch { host.controller.markBannerSeen(talk.talkId) }
            pinned = null
            open = false
        },
        actions = if (open) {
            null
        } else {
            {
                CaddieButton(
                    ProfileStrings.SEE_WHO_ELSE,
                    {
                        pinned = talk.talkId
                        open = true
                        scope.launch { host.controller.markBannerSeen(talk.talkId) }
                    },
                    Modifier.testTag("ended-see-who"),
                    variant = ButtonVariant.Tonal,
                    small = true,
                )
                CaddieButton(ProfileStrings.OPEN_TALK, { host.openTalk(talk.talkId) }, Modifier.testTag("ended-open-talk"), variant = ButtonVariant.Text, small = true)
            }
        },
        // The inline circle sits under the text row at the banner's own inset, not under the text.
        below = if (open) {
            { TalkPeopleBody(talk.talkId, interested = true, state = state, host = host, modifier = Modifier, startOpen = true, inBanner = true) }
        } else {
            null
        },
    ) {
        Text(
            buildAnnotatedString {
                append(ProfileStrings.ENDED_LEAD)
                withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(talk.title) }
                append(ProfileStrings.ENDED_TAIL)
            },
        )
    }
}

