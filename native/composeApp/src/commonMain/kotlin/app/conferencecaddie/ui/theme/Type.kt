package app.conferencecaddie.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.runtime.Immutable
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

// The web app sets no font of its own: its stack is system-ui, -apple-system, BlinkMacSystemFont,
// 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif, which is San Francisco on iPhones and
// Roboto on Android phones. FontFamily.Default is the same system font on each platform, so no font
// is bundled. Every size is in sp, so text follows the system font size setting.

private fun style(size: Int, weight: FontWeight = FontWeight.Normal, lineHeight: Float = 1.45f, letterSpacing: TextUnit = 0.em) =
    TextStyle(
        fontFamily = FontFamily.Default,
        fontSize = size.sp,
        fontWeight = weight,
        lineHeight = (size * lineHeight).sp,
        letterSpacing = letterSpacing,
    )

/** Text styles the web uses that Material's scale has no name for. */
@Immutable
data class CaddieType(
    /** .appbar-title: a screen title in the app bar. */
    val appBarTitle: TextStyle = style(22, FontWeight.Bold, 1.3f, (-0.01).em),
    /** .switcher-btn: the conference name in the app bar. */
    val switcher: TextStyle = style(20, FontWeight.Bold, 1.3f, (-0.01).em),
    /** .card-title. */
    val cardTitle: TextStyle = style(17, FontWeight.SemiBold, 1.3f),
    /** .settings-heading, .conf-heading, .day-header and filter-sheet legends (shown in capitals). */
    val sectionHeading: TextStyle = style(13, FontWeight.SemiBold, 1.45f, 0.02.em),
    /** .nav-item, the tab bar labels. */
    val navLabel: TextStyle = style(12, FontWeight.Medium, 1.3f),
    /** .tag. */
    val tag: TextStyle = style(12, FontWeight.Medium, 1.45f),
    /** .badge. */
    val badge: TextStyle = style(11, FontWeight.Bold, 1f),
    /** .btn. */
    val button: TextStyle = style(15, FontWeight.SemiBold, 1.3f),
    /** .btn-small, .interest-btn and .link. */
    val buttonSmall: TextStyle = style(14, FontWeight.SemiBold, 1.3f),
    /** .chip. */
    val chip: TextStyle = style(14, FontWeight.Medium, 1.3f),
    /** .state-title. */
    val stateTitle: TextStyle = style(17, FontWeight.SemiBold, 1.45f),
    /** .state-body and .dialog-body. */
    val stateBody: TextStyle = style(15),
    /** .screen-title: a screen's own title under the app bar, such as "My schedule". */
    val screenTitle: TextStyle = style(20, FontWeight.Bold),
    /** .sheet-header h2 and .dialog-title. */
    val sheetTitle: TextStyle = style(20, FontWeight.Bold, 1.3f),
    /** body text, .settings-row. */
    val body: TextStyle = style(16),
    /** .card-meta, .card-speakers, .settings-hint, .results-count. */
    val meta: TextStyle = style(14),
    /** .conf-meta, .settings-note, .footnote. */
    val note: TextStyle = style(13),
    /** .toast. */
    val toast: TextStyle = style(15),
    /** .appbar-back-labeled: the "‹ Settings" Back of Profile. */
    val backLabel: TextStyle = style(17),
    /** .pp-card-title and .pp-picker-title: a people card's heading. */
    val peopleCardTitle: TextStyle = style(17, FontWeight.Bold),
    /** .pp-section-title: a people screen's section heading, such as "People to meet". */
    val peopleSectionTitle: TextStyle = style(20, FontWeight.Bold, 1.45f, (-0.01).em),
    /** .pp-label and .pp-around: a field's label, and the accent "Around now" line. */
    val peopleLabel: TextStyle = style(14, FontWeight.SemiBold),
    /** .pp-notice-text: the fine print under a people prompt or setting. */
    val peopleNote: TextStyle = style(13, lineHeight = 1.5f),
    /** .pp-band: the proximity band on a person's card (line-height 18px). */
    val peopleBand: TextStyle = style(12, FontWeight.SemiBold, 1.5f),
    /** .pp-sample: the "Sample" pill, shown in capitals. */
    val peopleSample: TextStyle = style(12, FontWeight.Bold, 1.45f, 0.03.em),
) {
    /**
     * These styles with the web's line boxes: CSS puts half of a line's leading above it and half
     * below, the first and last lines included, where Compose by default trims the leading above the
     * first line and below the last. The people screens use it, so that their stacked texts are as
     * far apart as on the web.
     */
    fun withCssLineBoxes(): CaddieType {
        fun TextStyle.css() = copy(lineHeightStyle = CSS_LINE_BOXES)
        return copy(
            appBarTitle = appBarTitle.css(),
            switcher = switcher.css(),
            cardTitle = cardTitle.css(),
            sectionHeading = sectionHeading.css(),
            navLabel = navLabel.css(),
            tag = tag.css(),
            badge = badge.css(),
            button = button.css(),
            buttonSmall = buttonSmall.css(),
            chip = chip.css(),
            stateTitle = stateTitle.css(),
            stateBody = stateBody.css(),
            screenTitle = screenTitle.css(),
            sheetTitle = sheetTitle.css(),
            body = body.css(),
            meta = meta.css(),
            note = note.css(),
            toast = toast.css(),
            backLabel = backLabel.css(),
            peopleCardTitle = peopleCardTitle.css(),
            peopleSectionTitle = peopleSectionTitle.css(),
            peopleLabel = peopleLabel.css(),
            peopleNote = peopleNote.css(),
            peopleBand = peopleBand.css(),
            peopleSample = peopleSample.css(),
        )
    }

    private companion object {
        val CSS_LINE_BOXES = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None)
    }
}

/** Material's scale filled with the same sizes, for the Material components the apps use. */
internal fun materialTypography(t: CaddieType) = Typography(
    headlineSmall = t.appBarTitle,
    titleLarge = t.sheetTitle,
    titleMedium = t.cardTitle,
    titleSmall = t.button,
    bodyLarge = t.body,
    bodyMedium = t.meta,
    bodySmall = t.note,
    labelLarge = t.chip,
    labelMedium = t.navLabel,
    labelSmall = t.badge,
)
