package app.conferencecaddie.ui.people

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.FlowRowScope
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ProvideTextStyle
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import app.conferencecaddie.shared.people.PeopleText
import app.conferencecaddie.shared.people.Person
import app.conferencecaddie.shared.people.Proximity
import app.conferencecaddie.ui.components.ButtonVariant
import app.conferencecaddie.ui.components.CaddieButton
import app.conferencecaddie.ui.components.CaddieIconButton
import app.conferencecaddie.ui.components.CaddieSheet
import app.conferencecaddie.ui.components.CaddieSwitchVisual
import app.conferencecaddie.ui.components.ConfirmDialog
import app.conferencecaddie.ui.components.Hairline
import app.conferencecaddie.ui.components.LucideImage
import app.conferencecaddie.ui.components.Pill
import app.conferencecaddie.ui.components.SectionHeading
import app.conferencecaddie.ui.components.StateAction
import app.conferencecaddie.ui.components.caddieClickable
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie
import app.conferencecaddie.ui.theme.LocalCaddieType
import app.conferencecaddie.ui.theme.MOTION_MS
import kotlin.math.max
import kotlin.math.min

// The people screens' building blocks (web/src/people/people.css and nudges.css), with the web's
// exact sizes. They use the shell's tokens (Caddie.colors, Caddie.dimens, Caddie.type) and reuse the
// shell's components where those already match: CaddieButton for every .btn, CaddieIconButton for
// .icon-btn, CaddieChip, SearchField, CaddieSheet, ConfirmDialog, Toast, StateView, NeedsConnection,
// SettingsGroup and the settings rows.
//
// Computed-style gotchas of the web that these keep (do not "fix" them):
// - .pp-danger buttons ("Delete my profile" before confirming, the meet's Cancel, "Stop trying on
//   this device") render in the accent ink, not red: use ButtonVariant.Text. Only the filled
//   .btn-danger (ButtonVariant.Danger) and a destructive menu item are red.
// - Switch rows differ by where they sit (PeopleSwitchRow's variants).
// - A person's name has a line height of 1.3 (Caddie.type.cardTitle); body text and evidence 1.45.
// - "Remove" under People I met is stretched across the row with its label centred.

/** .pp-screen: the padding of a people screen (4 dp on top, the gutter at the sides, 24 dp below). */
val PeopleScreenPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 24.dp)

/** .pp-screen: the gap between the blocks of a people screen. */
val PeopleScreenGap: Dp = 20.dp

/**
 * .pp-screen as a scrolling column. A screen with a long list uses a LazyColumn with
 * [PeopleScreenPadding] instead, and then adds `Modifier.imePadding()` itself.
 *
 * The scrolling area ends above the keyboard (imePadding), as Settings' does, so a focused field is
 * never covered: iOS no longer slides the whole view up for the keyboard.
 */
@Composable
fun PeopleScreenColumn(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(PeopleScreenPadding),
        verticalArrangement = Arrangement.spacedBy(PeopleScreenGap),
        content = content,
    )
}

// -------------------------------------------------------------------------------------------------
// Cards, prompts, notices and banners

/**
 * .pp-card: a bordered surface card, padding 16, its blocks 12 dp apart ([gap]; Meet up's cards use
 * 10, the found card 14), with an optional [title] (.pp-card-title, 17/700, a heading).
 */
@Composable
fun PeopleCard(
    modifier: Modifier = Modifier,
    title: String? = null,
    gap: Dp = 12.dp,
    content: @Composable ColumnScope.() -> Unit,
) {
    val c = Caddie.colors
    val shape = RoundedCornerShape(Caddie.dimens.radius)
    Column(
        modifier.fillMaxWidth().clip(shape).background(c.surface).border(1.dp, c.border, shape).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(gap),
    ) {
        if (title != null) PeopleCardTitle(title)
        content()
    }
}

/** .pp-card-title: 17/700, a heading. */
@Composable
fun PeopleCardTitle(text: String, modifier: Modifier = Modifier) {
    Text(text, style = Caddie.type.peopleCardTitle, color = Caddie.colors.text, modifier = modifier.semantics { heading() })
}

/**
 * The people screens' text: the app's styles with the web's line boxes
 * ([app.conferencecaddie.ui.theme.CaddieType.withCssLineBoxes]), so that stacked texts (a card's
 * name, zone, about, evidence and topics) sit as far apart as on the web. The People layer draws
 * every people screen, sheet and control inside it.
 */
@Composable
fun PeopleType(content: @Composable () -> Unit) {
    val type = Caddie.type
    val people = remember(type) { type.withCssLineBoxes() }
    CompositionLocalProvider(LocalCaddieType provides people, content = content)
}

/**
 * .pp-prompt: a bordered card with the content left-aligned beside an optional 22 dp accent [icon]:
 * [title] (17/600, a heading), [body] (15, secondary), [notice] (.pp-notice-text) and a small
 * [action] button ([actionVariant], primary by default) 12 dp below. [footer] goes under it, for
 * an error line. Used by "Find people worth meeting", "Turn on visibility...", "No requests yet"
 * and the ended meet-up states.
 */
@Composable
fun PeoplePrompt(
    title: String,
    modifier: Modifier = Modifier,
    icon: LucideIcon? = null,
    body: String? = null,
    notice: String? = null,
    action: StateAction? = null,
    actionVariant: ButtonVariant = ButtonVariant.Primary,
    actionEnabled: Boolean = true,
    footer: (@Composable ColumnScope.() -> Unit)? = null,
) {
    val c = Caddie.colors
    val shape = RoundedCornerShape(Caddie.dimens.radius)
    Row(
        modifier.fillMaxWidth().clip(shape).background(c.surface).border(1.dp, c.border, shape).padding(16.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (icon != null) LucideImage(icon, null, Modifier.padding(top = 2.dp), size = 22.dp, tint = c.accent)
        Column(Modifier.weight(1f)) {
            Text(title, style = Caddie.type.stateTitle, color = c.text, modifier = Modifier.semantics { heading() })
            if (body != null) Text(body, style = Caddie.type.stateBody, color = c.text2, modifier = Modifier.padding(top = 4.dp))
            if (notice != null) NoticeText(notice)
            if (action != null) {
                CaddieButton(
                    action.label,
                    action.onClick,
                    Modifier.padding(top = 12.dp),
                    variant = actionVariant,
                    small = true,
                    enabled = actionEnabled,
                    icon = action.icon,
                )
            }
            footer?.invoke(this)
        }
    }
}

/**
 * .pp-notice: the accent-tinted box of an explanation that asks for a decision (the presence,
 * position, sharing and push notices, the delete confirmation). Text inside is 14 sp; blocks are
 * 10 dp apart.
 */
@Composable
fun PeopleNotice(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val c = Caddie.colors
    Column(
        modifier.fillMaxWidth().background(c.accentTint, RoundedCornerShape(Caddie.dimens.radius)).padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        ProvideTextStyle(Caddie.type.meta.copy(color = c.text)) { content() }
    }
}

/** .pp-notice-text: fine print, 13/1.5 secondary, 8 dp below what precedes it. */
@Composable
fun NoticeText(text: String, modifier: Modifier = Modifier) {
    Text(text, style = Caddie.type.peopleNote, color = Caddie.colors.text2, modifier = modifier.padding(top = 8.dp))
}

/**
 * .pp-banner: an accent-tinted banner with a 20 dp accent [icon], the [text] (15 sp), an optional
 * close button ([onClose], named [closeLabel]) and [actions] inset 30 dp under the text. [below]
 * goes under the text row at the banner's own inset, full width (the ended-talk banner's inline
 * circle). [nudge] is .pp-nudge: a 1 dp accent-ink border and medium-weight text. [announce] reads
 * it out when it appears (role=status). Used by the ended-talk, nudge, pending-delete and hidden
 * banners.
 */
@Composable
fun PeopleBanner(
    icon: LucideIcon,
    modifier: Modifier = Modifier,
    nudge: Boolean = false,
    onClose: (() -> Unit)? = null,
    closeLabel: String = Strings.Common.CLOSE,
    announce: Boolean = false,
    actions: (@Composable FlowRowScope.() -> Unit)? = null,
    below: (@Composable ColumnScope.() -> Unit)? = null,
    text: @Composable () -> Unit,
) {
    val c = Caddie.colors
    val shape = RoundedCornerShape(Caddie.dimens.radius)
    Column(
        modifier
            .fillMaxWidth()
            .background(c.accentTint, shape)
            .then(if (nudge) Modifier.border(1.dp, c.accentInk, shape) else Modifier)
            .then(if (announce) Modifier.semantics { liveRegion = LiveRegionMode.Polite } else Modifier)
            .padding(start = 14.dp, top = 10.dp, end = 6.dp, bottom = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            LucideImage(icon, null, Modifier.padding(top = 12.dp), size = 20.dp, tint = c.accentInk)
            Box(Modifier.weight(1f).padding(top = 10.dp, end = if (onClose == null) 8.dp else 0.dp)) {
                val style = Caddie.type.stateBody.copy(color = c.text)
                ProvideTextStyle(if (nudge) style.copy(fontWeight = FontWeight.Medium) else style) { text() }
            }
            if (onClose != null) CaddieIconButton(LucideIcon.X, closeLabel, onClose, iconSize = 20.dp)
        }
        if (actions != null) ActionsRow(Modifier.padding(start = 30.dp), content = actions)
        below?.invoke(this)
    }
}

// -------------------------------------------------------------------------------------------------
// Form fields

/**
 * .pp-text: a labelled text field. [label] (14/600) sits 6 dp above the field: at least 44 dp tall,
 * padding 10/12, radius 10, a 1 dp strong border (the danger colour while [error] is set, a 2 dp
 * accent ring while focused) on the page colour, 16 sp text. Under it, [error] (danger) or [hint]
 * (secondary) at 14 sp, such as "{n} of 140". With [errorLinkLabel] and [onErrorLink], the error
 * ends in an inline link, such as "Open my profile" after an error about the profile. [multiline]
 * is the web's textarea: three rows at a line height of 1.4. Input past [maxLength] is cut.
 * [fieldModifier] goes on the input itself (a test tag, a focus requester).
 */
@Composable
fun PeopleTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    placeholder: String? = null,
    hint: String? = null,
    error: String? = null,
    maxLength: Int? = null,
    multiline: Boolean = false,
    enabled: Boolean = true,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    fieldModifier: Modifier = Modifier,
    errorLinkLabel: String? = null,
    onErrorLink: (() -> Unit)? = null,
) {
    val c = Caddie.colors
    val shape = RoundedCornerShape(10.dp)
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val textStyle = (if (multiline) Caddie.type.body.copy(lineHeight = 22.4.sp) else Caddie.type.body).copy(color = c.text)
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, style = Caddie.type.peopleLabel, color = c.text, modifier = Modifier.clearAndSetSemantics { })
        BasicTextField(
            value = value,
            onValueChange = { onValueChange(if (maxLength != null) it.take(maxLength) else it) },
            enabled = enabled,
            singleLine = !multiline,
            minLines = if (multiline) 3 else 1,
            textStyle = textStyle,
            cursorBrush = SolidColor(c.accent),
            interactionSource = interaction,
            keyboardOptions = keyboardOptions,
            keyboardActions = keyboardActions,
            modifier = fieldModifier.fillMaxWidth().semantics {
                contentDescription = label
                if (error != null) error(error)
            },
            decorationBox = { inner ->
                Box(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = Caddie.dimens.minTouch)
                        .alpha(if (enabled) 1f else 0.45f)
                        .background(c.bg, shape)
                        .border(
                            if (focused) 2.dp else 1.dp,
                            when {
                                focused -> c.accent
                                error != null -> c.danger
                                else -> c.borderStrong
                            },
                            shape,
                        )
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                    contentAlignment = if (multiline) Alignment.TopStart else Alignment.CenterStart,
                ) {
                    if (value.isEmpty() && placeholder != null) {
                        // A one-line field clips its placeholder on one line, as the web's input does.
                        Text(
                            placeholder,
                            style = textStyle,
                            color = c.text2,
                            maxLines = if (multiline) Int.MAX_VALUE else 1,
                            softWrap = multiline,
                            overflow = TextOverflow.Clip,
                        )
                    }
                    inner()
                }
            },
        )
        when {
            error != null && errorLinkLabel != null && onErrorLink != null -> MessageWithLink(error, errorLinkLabel, onErrorLink)
            error != null -> ErrorText(error)
            hint != null -> HintText(hint)
        }
    }
}

/**
 * .pp-select: a labelled choice in the same box as [PeopleTextField], showing [value] and a chevron.
 * Tapping it opens a sheet titled [label] with one radio row per option, as a phone's own select
 * does; picking one closes it. Used for the zone pickers ("Zone", "Meeting point").
 */
@Composable
fun PeopleSelect(
    value: String?,
    options: List<String>,
    onSelect: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    showLabel: Boolean = true,
) {
    val c = Caddie.colors
    val shape = RoundedCornerShape(10.dp)
    var open by remember { mutableStateOf(false) }
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (showLabel) Text(label, style = Caddie.type.peopleLabel, color = c.text, modifier = Modifier.clearAndSetSemantics { })
        Row(
            Modifier
                .fillMaxWidth()
                .minimumInteractiveComponentSize()
                .heightIn(min = Caddie.dimens.minTouch)
                .alpha(if (enabled) 1f else 0.45f)
                .background(c.bg, shape)
                .border(1.dp, c.borderStrong, shape)
                .caddieClickable(shape, role = Role.DropdownList, enabled = enabled) { open = true }
                .semantics {
                    contentDescription = label
                    stateDescription = value ?: ""
                }
                .padding(start = 12.dp, end = 8.dp, top = 10.dp, bottom = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(value ?: "", style = Caddie.type.body, color = c.text, modifier = Modifier.weight(1f))
            LucideImage(LucideIcon.ChevronDown, null, size = 20.dp)
        }
    }
    if (open) {
        CaddieSheet(title = label, onClose = { open = false }) {
            Column(Modifier.selectableGroup().padding(bottom = 16.dp)) {
                options.forEach { option ->
                    RadioRow(
                        option,
                        selected = option == value,
                        onClick = {
                            open = false
                            onSelect(option)
                        },
                        variant = RadioVariant.Option,
                    )
                }
            }
        }
    }
}

/** The two radio rows of the web. */
enum class RadioVariant {
    /** .pp-radio: 15 sp, the radio 10 dp from the label ("How long"). The web's row is 32 dp; here it keeps the 44 dp touch target. */
    Compact,

    /** .option: 16 sp, 14 dp gap, 48 dp tall (the report sheet's reasons, the zone sheet). */
    Option,
}

/** A radio button and its label; the whole row selects. Put rows in a `Modifier.selectableGroup()`. */
@Composable
fun RadioRow(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    variant: RadioVariant = RadioVariant.Compact,
    enabled: Boolean = true,
) {
    val c = Caddie.colors
    val compact = variant == RadioVariant.Compact
    Row(
        modifier
            .fillMaxWidth()
            .minimumInteractiveComponentSize()
            .heightIn(min = if (compact) Caddie.dimens.minTouch else 48.dp)
            .alpha(if (enabled) 1f else 0.45f)
            .selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(if (compact) 10.dp else 14.dp),
    ) {
        // The same 20 dp radio as OptionRow: filled with the accent and a dot when chosen.
        Box(
            Modifier.size(20.dp).then(if (selected) Modifier.background(c.accent, CircleShape) else Modifier.border(2.dp, c.text2, CircleShape)),
            contentAlignment = Alignment.Center,
        ) {
            if (selected) Box(Modifier.size(8.dp).background(c.onAccent, CircleShape))
        }
        Text(label, style = if (compact) Caddie.type.stateBody else Caddie.type.body, color = c.text, modifier = Modifier.weight(1f))
    }
}

/** Where a [PeopleSwitchRow] sits; the web gives each place its own size. */
enum class SwitchRowVariant {
    /** .settings-row.pp-switch-row: 16 sp, padding 12/16, at least 48 dp, a hairline above unless first. */
    Settings,

    /** .pp-card .pp-switch-row: 15 sp, no padding, at least 48 dp, label and switch at either end. */
    InCard,

    /** .pp-presence .pp-switch-row: as [InCard], at least 44 dp. */
    Presence,
}

/**
 * .pp-switch-row: [label] and the web's switch, 12 dp apart; the whole row toggles. [leading] goes
 * [leadingGap] before the label (the push row's bell, 8 dp) and [trailing] [trailingGap] before the
 * switch (its "On", 10 dp). [rowModifier] goes on the row that toggles (a test tag), [modifier] on
 * the whole, hairline included. In the [SwitchRowVariant.Settings] variant, [first] leaves out the
 * hairline above.
 */
@Composable
fun PeopleSwitchRow(
    label: String,
    checked: Boolean,
    onChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    variant: SwitchRowVariant = SwitchRowVariant.InCard,
    enabled: Boolean = true,
    first: Boolean = true,
    leading: (@Composable RowScope.() -> Unit)? = null,
    trailing: (@Composable RowScope.() -> Unit)? = null,
    rowModifier: Modifier = Modifier,
    leadingGap: Dp = 12.dp,
    trailingGap: Dp = 12.dp,
) {
    val settings = variant == SwitchRowVariant.Settings
    Column(modifier.fillMaxWidth()) {
        if (settings && !first) Hairline()
        Row(
            Modifier
                .fillMaxWidth()
                .minimumInteractiveComponentSize()
                .heightIn(min = if (variant == SwitchRowVariant.Presence) Caddie.dimens.minTouch else 48.dp)
                .toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = onChange)
                .then(rowModifier)
                .then(if (settings) Modifier.padding(horizontal = 16.dp, vertical = 12.dp) else Modifier),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(leadingGap)) {
                leading?.invoke(this)
                Text(label, style = if (settings) Caddie.type.body else Caddie.type.stateBody, color = Caddie.colors.text)
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(trailingGap)) {
                trailing?.invoke(this)
                CaddieSwitchVisual(checked, Modifier.alpha(if (enabled) 1f else 0.45f))
            }
        }
    }
}

// -------------------------------------------------------------------------------------------------
// Pills and lines of a person

/** .pp-band: a person's proximity band ("Same zone", "Near", "Around"); nothing for the venue or null. Never a distance. */
@Composable
fun BandPill(proximity: Proximity?, modifier: Modifier = Modifier) {
    val label = when (proximity) {
        Proximity.SameZone -> PeopleCommonStrings.BAND_SAME_ZONE
        Proximity.Near -> PeopleCommonStrings.BAND_NEAR
        Proximity.Around -> PeopleCommonStrings.BAND_AROUND
        Proximity.Venue, null -> return
    }
    val c = Caddie.colors
    Text(
        label,
        style = Caddie.type.peopleBand,
        color = c.text,
        modifier = modifier.padding(start = 4.dp).background(c.fill, Pill).padding(horizontal = 8.dp, vertical = 1.dp),
    )
}

/** .pp-sample: the "SAMPLE" pill of a demo profile, read as "Sample profile, not a real person". */
@Composable
fun SamplePill(modifier: Modifier = Modifier) {
    val c = Caddie.colors
    Box(
        modifier
            .background(c.accentTint, Pill)
            .border(1.dp, c.accentInk, Pill)
            .padding(horizontal = 10.dp, vertical = 2.dp)
            .clearAndSetSemantics { contentDescription = PeopleCommonStrings.SAMPLE_SPOKEN },
    ) {
        Text(PeopleCommonStrings.SAMPLE.uppercase(), style = Caddie.type.peopleSample, color = c.accentInk, maxLines = 1)
    }
}

/** SampleNote: the line above a list when any of [people] is a sample profile; nothing otherwise. */
@Composable
fun SampleNote(people: List<Person>, modifier: Modifier = Modifier) {
    if (people.none { it.sample }) return
    Text(PeopleCommonStrings.SAMPLE_NOTE, style = Caddie.type.note, color = Caddie.colors.text2, modifier = modifier)
}

/**
 * .pp-around: the map pin and [text] in the accent ink, 14/600, such as "Around · Expo hall"
 * ([PeopleCommonStrings.around]) or, on the presence card, "Expo hall · by the coffee cart", then
 * the [band]. Pass a zone and band read through PeoplePrivacy only.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AroundLine(text: String, modifier: Modifier = Modifier, band: Proximity? = null) {
    val c = Caddie.colors
    // The band moves under the text when both do not fit on one line (large text, a long zone).
    FlowRow(
        modifier,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
        itemVerticalAlignment = Alignment.CenterVertically,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            LucideImage(LucideIcon.MapPin, null, size = 16.dp, tint = c.accentInk)
            Text(text, style = Caddie.type.peopleLabel, color = c.accentInk, modifier = Modifier.weight(1f, fill = false))
        }
        BandPill(band)
    }
}

/** .pp-person: a person's card, 8 dp between its blocks, padding 14/16. [broad] is the dashed, transparent card of a broad match; [revealed] rings it in the accent ("See who"). */
@Composable
fun PersonFrame(
    modifier: Modifier = Modifier,
    broad: Boolean = false,
    revealed: Boolean = false,
    content: @Composable ColumnScope.() -> Unit,
) {
    val c = Caddie.colors
    val radius = Caddie.dimens.radius
    val shape = RoundedCornerShape(radius)
    val ring by animateFloatAsState(if (revealed) 1f else 0f, tween(if (revealed) MOTION_MS else 600))
    Column(
        modifier
            .fillMaxWidth()
            .drawBehind {
                if (ring > 0f) {
                    val w = 3.dp.toPx()
                    drawRoundRect(
                        color = c.accent.copy(alpha = c.accent.alpha * ring),
                        topLeft = Offset(-w, -w),
                        size = Size(size.width + 2 * w, size.height + 2 * w),
                        cornerRadius = CornerRadius(radius.toPx() + w),
                    )
                }
            }
            .then(if (!broad && c.cardShadow) Modifier.shadow(1.dp, shape, ambientColor = c.border, spotColor = c.border) else Modifier)
            .background(if (broad) Color.Transparent else c.surface, shape)
            .then(
                if (broad) {
                    Modifier.drawBehind {
                        val w = 1.dp.toPx()
                        drawRoundRect(
                            color = c.border,
                            topLeft = Offset(w / 2, w / 2),
                            size = Size(size.width - w, size.height - w),
                            cornerRadius = CornerRadius(radius.toPx()),
                            style = Stroke(width = w, pathEffect = PathEffect.dashPathEffect(floatArrayOf(3 * w, 3 * w))),
                        )
                    }
                } else {
                    Modifier.border(1.dp, c.border, shape)
                },
            )
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        content = content,
    )
}

/** .pp-opener: the suggested opener (or an ask's note) in an accent-tinted box with a speech bubble; `<mark>` highlights as [EvidenceText]. */
@Composable
fun OpenerBox(text: String, modifier: Modifier = Modifier) {
    val c = Caddie.colors
    Row(
        modifier.fillMaxWidth().background(c.accentTint, RoundedCornerShape(10.dp)).padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        LucideImage(LucideIcon.MessageCircle, null, Modifier.padding(top = 2.dp), size = 18.dp, tint = c.accentInk)
        EvidenceText(text, Modifier.weight(1f))
    }
}

// -------------------------------------------------------------------------------------------------
// Headings, lines and rows

/** .pp-section-head: a row at least 44 dp tall with a [SectionTitle] and an optional [trailing] part. */
@Composable
fun SectionHead(title: String, modifier: Modifier = Modifier, trailing: (@Composable RowScope.() -> Unit)? = null) {
    Row(
        modifier.fillMaxWidth().heightIn(min = Caddie.dimens.minTouch),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        SectionTitle(title, Modifier.weight(1f))
        trailing?.invoke(this)
    }
}

/** .pp-section-title: 20/700, letter-spacing -0.01em, a heading ("People to meet", "Requests"). */
@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(text, style = Caddie.type.peopleSectionTitle, color = Caddie.colors.text, modifier = modifier.semantics { heading() })
}

/** .pp-subhead: 13/600 capitals, secondary, 4 dp from above, a heading ("How to reach me", "Speakers"). */
@Composable
fun Subhead(text: String, modifier: Modifier = Modifier) {
    SectionHeading(text, modifier.padding(top = 4.dp))
}

/** .pp-group-title: a list group's title ("In Expo hall", "Elsewhere at the venue"); the same look as [Subhead]. */
@Composable
fun GroupTitle(text: String, modifier: Modifier = Modifier) {
    SectionHeading(text, modifier.padding(top = 4.dp))
}

/** .pp-hint: a 14 sp secondary line. [pad] adds .pp-pad (8 dp above and below), as for "Finding people…". */
@Composable
fun HintText(text: String, modifier: Modifier = Modifier, pad: Boolean = false) {
    Text(text, style = Caddie.type.meta, color = Caddie.colors.text2, modifier = modifier.then(if (pad) Modifier.padding(vertical = 8.dp) else Modifier))
}

/** .pp-error: a 14 sp line in the danger colour, read out when it appears. [pad] adds .pp-pad. */
@Composable
fun ErrorText(text: String, modifier: Modifier = Modifier, pad: Boolean = false) {
    Text(
        text,
        style = Caddie.type.meta,
        color = Caddie.colors.danger,
        modifier = modifier.semantics { liveRegion = LiveRegionMode.Polite }.then(if (pad) Modifier.padding(vertical = 8.dp) else Modifier),
    )
}

/**
 * A message followed by an inline link (.pp-inline-link: accent ink, 600), such as an error and
 * "Open my profile". [error] colours the message as .pp-error, else as .pp-hint.
 */
@Composable
fun MessageWithLink(message: String, linkLabel: String, onLink: () -> Unit, modifier: Modifier = Modifier, error: Boolean = true) {
    val c = Caddie.colors
    val text = buildAnnotatedString {
        append(message)
        append(" ")
        withLink(
            LinkAnnotation.Clickable(
                tag = "link",
                styles = TextLinkStyles(SpanStyle(color = c.accentInk, fontWeight = FontWeight.SemiBold)),
                linkInteractionListener = { onLink() },
            ),
        ) { append(linkLabel) }
    }
    Text(
        text,
        style = Caddie.type.meta,
        color = if (error) c.danger else c.text2,
        modifier = modifier.heightIn(min = Caddie.dimens.minTouch).wrapContentHeight().semantics { if (error) liveRegion = LiveRegionMode.Polite },
    )
}

/** .pp-actions: buttons in a row that wraps, 8 dp apart, centred on each line. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ActionsRow(modifier: Modifier = Modifier, content: @Composable FlowRowScope.() -> Unit) {
    FlowRow(
        modifier,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        itemVerticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}

/**
 * .pp-progress.pp-progress-top: the 2 dp bar with a sliding accent segment (40% wide, one second,
 * ease-in-out) shown while a list is fetched again. Put it in a Box over the list, aligned to the
 * top: it draws 6 dp above the box's top edge and takes no room, and fades in and out. Dim the
 * list itself with [refreshing].
 */
@Composable
fun RefreshBar(active: Boolean, modifier: Modifier = Modifier) {
    val alpha by animateFloatAsState(if (active) 1f else 0f, tween(MOTION_MS))
    if (!active && alpha == 0f) return
    BoxWithConstraints(modifier.fillMaxWidth().offset(y = (-6).dp).height(2.dp).alpha(alpha).clip(RoundedCornerShape(2.dp))) {
        val width = maxWidth
        val transition = rememberInfiniteTransition()
        val x by transition.animateFloat(-1f, 2.5f, infiniteRepeatable(tween(1000, easing = EASE_IN_OUT)))
        Box(
            Modifier
                .width(width * 0.4f)
                .height(2.dp)
                .offset(x = width * 0.4f * x)
                .background(Caddie.colors.accent, RoundedCornerShape(2.dp)),
        )
    }
}

/** .is-refreshing: dims a list to 55% while [active], over the shell's motion time. */
@Composable
fun Modifier.refreshing(active: Boolean): Modifier {
    val alpha by animateFloatAsState(if (active) 0.55f else 1f, tween(MOTION_MS))
    return this.alpha(alpha)
}

/** CSS `ease-in-out`. */
private val EASE_IN_OUT = CubicBezierEasing(0.42f, 0f, 0.58f, 1f)

// -------------------------------------------------------------------------------------------------
// The overflow menu

/** One item of an [OverflowMenu]. [destructive] items are red (.menu-item.is-danger). */
@Immutable
data class MenuItem(val label: String, val onSelect: () -> Unit, val destructive: Boolean = false, val enabled: Boolean = true)

/**
 * OverflowMenu (web common.tsx): the 44 dp ⋮ button named [label] ("Options for {name}") and, while
 * open, the .menu under it, its right edge 8 dp in from the button's: at least 200 dp wide, padding
 * 6, radius 12, raised surface with a border and the large shadow; items at least 44 dp tall,
 * padding 0/12, radius 8, 15 sp. Choosing an item closes the menu first. Back or a tap outside
 * closes it.
 */
@Composable
fun OverflowMenu(label: String, items: List<MenuItem>, modifier: Modifier = Modifier) {
    val c = Caddie.colors
    var open by remember { mutableStateOf(false) }
    val density = LocalDensity.current
    Box(modifier) {
        CaddieIconButton(LucideIcon.EllipsisVertical, label, { open = !open }, iconSize = 22.dp)
        if (open) {
            val position = remember(density) { MenuPosition(with(density) { 8.dp.roundToPx() }, with(density) { 4.dp.roundToPx() }) }
            Popup(popupPositionProvider = position, onDismissRequest = { open = false }, properties = PopupProperties(focusable = true)) {
                val shape = RoundedCornerShape(Caddie.dimens.radius)
                Column(
                    Modifier
                        .widthIn(min = 200.dp)
                        .width(IntrinsicSize.Max)
                        .shadow(8.dp, shape, ambientColor = c.shadowLg, spotColor = c.shadowLg)
                        .background(c.surfaceRaised, shape)
                        .border(1.dp, c.border, shape)
                        .padding(6.dp)
                        .testTag("overflow-menu"),
                ) {
                    items.forEach { item ->
                        Box(
                            Modifier
                                .fillMaxWidth()
                                .minimumInteractiveComponentSize()
                                .heightIn(min = Caddie.dimens.minTouch)
                                .alpha(if (item.enabled) 1f else 0.45f)
                                .caddieClickable(RoundedCornerShape(8.dp), enabled = item.enabled) {
                                    open = false
                                    item.onSelect()
                                }
                                .padding(horizontal = 12.dp),
                            contentAlignment = Alignment.CenterStart,
                        ) {
                            Text(item.label, style = Caddie.type.stateBody, color = if (item.destructive) c.danger else c.text)
                        }
                    }
                }
            }
        }
    }
}

/** Places the menu under its button, its right edge [endInset] in from the button's, flipping above when there is no room below. */
private class MenuPosition(private val endInset: Int, private val gap: Int) : PopupPositionProvider {
    override fun calculatePosition(anchorBounds: IntRect, windowSize: IntSize, layoutDirection: LayoutDirection, popupContentSize: IntSize): IntOffset {
        val x = (anchorBounds.right - endInset - popupContentSize.width).coerceIn(0, max(0, windowSize.width - popupContentSize.width))
        val below = anchorBounds.bottom + gap
        val y = if (below + popupContentSize.height <= windowSize.height) below else max(0, anchorBounds.top - gap - popupContentSize.height)
        return IntOffset(x, y)
    }
}

// -------------------------------------------------------------------------------------------------
// Evidence: server text with <mark> highlights

/**
 * Server text that may hold `<mark>` highlights (web util.tsx `Marked`): [text] is what to show and
 * [marks] the highlighted ranges of it. The server sends the matched passage HTML-escaped with
 * `<mark>` and `</mark>` as its only tags, so [parse] treats exactly those two as tags, decodes the
 * entities of the rest once (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`, `&nbsp;` and numeric
 * ones), and keeps everything else literally: no other markup is ever interpreted, and an escaped
 * `&lt;mark&gt;` stays the visible text "<mark>".
 */
@Immutable
data class MarkedText(val text: String, val marks: List<IntRange>) {
    /** The text with each mark in [markText], for a Text that draws the mark backgrounds itself ([EvidenceText]). */
    fun toAnnotatedString(markText: Color): AnnotatedString = buildAnnotatedString {
        append(text)
        marks.forEach { addStyle(SpanStyle(color = markText), it.first, it.last + 1) }
    }

    companion object {
        private val TAG = Regex("</?mark>")
        private val ENTITY = Regex("&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);")
        private val NAMED = mapOf("amp" to "&", "lt" to "<", "gt" to ">", "quot" to "\"", "apos" to "'", "nbsp" to " ")

        fun parse(source: String): MarkedText {
            val out = StringBuilder()
            val marks = ArrayList<IntRange>()
            var marked = false
            var pos = 0
            fun add(raw: String) {
                if (raw.isEmpty()) return
                val start = out.length
                out.append(decode(raw))
                if (marked && out.length > start) marks += start until out.length
            }
            for (tag in TAG.findAll(source)) {
                add(source.substring(pos, tag.range.first))
                marked = tag.value == "<mark>"
                pos = tag.range.last + 1
            }
            add(source.substring(pos))
            return MarkedText(out.toString(), marks)
        }

        /** The entities of [s] decoded once, as the web's decode(): unknown or out-of-range ones stay as written. */
        fun decode(s: String): String = ENTITY.replace(s) { m ->
            val body = m.groupValues[1]
            if (body.startsWith("#")) {
                val code = if (body.startsWith("#x")) body.substring(2).toLongOrNull(16) else body.substring(1).toLongOrNull()
                // Surrogate halves are not characters; they stay as written too.
                if (code == null || code < 1 || code > 0x10FFFF || code in 0xD800L..0xDFFFL) m.value else codePointToString(code.toInt())
            } else {
                NAMED[body] ?: m.value
            }
        }

        private fun codePointToString(cp: Int): String = if (cp < 0x10000) {
            cp.toChar().toString()
        } else {
            val v = cp - 0x10000
            charArrayOf((0xD800 + (v shr 10)).toChar(), (0xDC00 + (v and 0x3FF)).toChar()).concatToString()
        }
    }
}

/**
 * Server text with its `<mark>` highlights drawn as the web draws `mark` in .pp-evidence,
 * .pp-opener and .pp-reasons: the mark background with 2 dp on either side and 3 dp corners, the
 * text in the mark colour. Nothing but `<mark>` is interpreted ([MarkedText]).
 */
@Composable
fun EvidenceText(
    text: String,
    modifier: Modifier = Modifier,
    style: TextStyle = Caddie.type.stateBody,
    color: Color = Caddie.colors.text,
    maxLines: Int = Int.MAX_VALUE,
) {
    val c = Caddie.colors
    val marked = remember(text) { MarkedText.parse(text) }
    val annotated = remember(marked, c.markText) { marked.toAnnotatedString(c.markText) }
    var layout by remember(text) { mutableStateOf<TextLayoutResult?>(null) }
    Text(
        annotated,
        modifier = modifier.drawBehind {
            val l = layout ?: return@drawBehind
            val pad = 2.dp.toPx()
            val radius = CornerRadius(3.dp.toPx())
            for (range in marked.marks) {
                val start = range.first
                val end = range.last + 1
                if (start >= l.layoutInput.text.length) continue
                val firstLine = l.getLineForOffset(start)
                val lastLine = l.getLineForOffset(end - 1)
                for (line in firstLine..min(lastLine, l.lineCount - 1)) {
                    val from = max(start, l.getLineStart(line))
                    val to = min(end, l.getLineEnd(line, visibleEnd = true))
                    if (to <= from) continue
                    val a = l.getBoundingBox(from)
                    val b = l.getBoundingBox(to - 1)
                    val left = min(a.left, b.left)
                    val right = max(a.right, b.right)
                    val top = l.getLineTop(line)
                    drawRoundRect(c.markBg, Offset(left - pad, top), Size(right - left + 2 * pad, l.getLineBottom(line) - top), radius)
                }
            }
        },
        style = style,
        color = color,
        maxLines = maxLines,
        overflow = TextOverflow.Ellipsis,
        onTextLayout = { layout = it },
    )
}

// -------------------------------------------------------------------------------------------------
// The block confirmation

/** The confirmation before a block (connect.ts blockWithConfirm): "Block {name}?", the web's body, and a red Block. */
@Composable
fun BlockConfirmDialog(name: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    ConfirmDialog(
        title = PeopleCommonStrings.blockTitle(name),
        body = PeopleText.BLOCK_BODY,
        confirmLabel = PeopleCommonStrings.BLOCK,
        onConfirm = onConfirm,
        onDismiss = onDismiss,
        destructive = true,
        testTag = "block-confirm",
    )
}
