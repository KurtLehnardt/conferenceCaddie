package app.conferencecaddie.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

// The design tokens of the web app (web/src/styles.css, the custom properties on :root and their
// dark-mode values), so both apps look like the web app. Names follow the CSS properties:
// --text-2 is text2, --accent-ink is accentInk, and so on. Sizes in CSS pixels map one to one onto
// density-independent pixels (dp) and, for text, scalable pixels (sp), which is what a phone browser
// does at the web app's device-width viewport.

private fun rgba(r: Int, g: Int, b: Int, a: Float) = Color(r / 255f, g / 255f, b / 255f, a)

/** The colour tokens of one theme. */
@Immutable
data class CaddieColors(
    val isDark: Boolean,
    /** --bg: the page behind cards. */
    val bg: Color,
    val surface: Color,
    val surfaceRaised: Color,
    /** --fill: quiet backgrounds such as the search field, tags and hover states. */
    val fill: Color,
    val fillStrong: Color,
    val segmentOn: Color,
    val text: Color,
    /** --text-2: secondary text and icons. */
    val text2: Color,
    val border: Color,
    val borderStrong: Color,
    val accent: Color,
    /** --accent-ink: accent-coloured text, which needs more contrast than the accent itself. */
    val accentInk: Color,
    val onAccent: Color,
    val accentTint: Color,
    val danger: Color,
    val dangerTint: Color,
    /** The text on a filled danger button (.btn-danger). */
    val onDanger: Color,
    val warning: Color,
    val markBg: Color,
    val markText: Color,
    val scrim: Color,
    val toastBg: Color,
    val toastText: Color,
    val toastAction: Color,
    /** --shadow-sm: cards have a hairline shadow in light mode and none in dark mode. */
    val cardShadow: Boolean,
    /** The colour of --shadow-lg, used by sheets, dialogs, menus and toasts. */
    val shadowLg: Color,
)

val LightColors = CaddieColors(
    isDark = false,
    bg = Color(0xFFF5F6F8),
    surface = Color(0xFFFFFFFF),
    surfaceRaised = Color(0xFFFFFFFF),
    fill = Color(0xFFECEEF2),
    fillStrong = Color(0xFFE2E5EA),
    segmentOn = Color(0xFFFFFFFF),
    text = Color(0xFF14171C),
    text2 = Color(0xFF5A616D),
    border = rgba(20, 23, 28, 0.1f),
    borderStrong = rgba(20, 23, 28, 0.18f),
    accent = Color(0xFF2457D6),
    accentInk = Color(0xFF1D47B3),
    onAccent = Color(0xFFFFFFFF),
    accentTint = rgba(36, 87, 214, 0.1f),
    danger = Color(0xFFC3261F),
    dangerTint = rgba(195, 38, 31, 0.08f),
    onDanger = Color(0xFFFFFFFF),
    warning = Color(0xFF9A5B00),
    markBg = Color(0xFFFFE98A),
    markText = Color(0xFF14171C),
    scrim = rgba(12, 14, 18, 0.4f),
    toastBg = Color(0xFF23262D),
    toastText = Color(0xFFF3F4F6),
    toastAction = Color(0xFF9DBAFF),
    cardShadow = true,
    shadowLg = rgba(20, 23, 28, 0.16f),
)

val DarkColors = CaddieColors(
    isDark = true,
    bg = Color(0xFF0F1115),
    surface = Color(0xFF181B21),
    surfaceRaised = Color(0xFF20242B),
    fill = Color(0xFF242830),
    fillStrong = Color(0xFF2D323B),
    segmentOn = Color(0xFF3A404B),
    text = Color(0xFFE9EBEF),
    text2 = Color(0xFFA4ABB7),
    border = rgba(255, 255, 255, 0.09f),
    borderStrong = rgba(255, 255, 255, 0.16f),
    accent = Color(0xFF85A8FF),
    accentInk = Color(0xFFA9C1FF),
    onAccent = Color(0xFF0B1736),
    accentTint = rgba(133, 168, 255, 0.16f),
    danger = Color(0xFFFF7B72),
    dangerTint = rgba(255, 123, 114, 0.12f),
    onDanger = Color(0xFF1A0503),
    warning = Color(0xFFF2B45A),
    markBg = rgba(255, 214, 10, 0.3f),
    markText = Color(0xFFFFF6D6),
    scrim = rgba(0, 0, 0, 0.6f),
    toastBg = Color(0xFFE9EBEF),
    toastText = Color(0xFF14171C),
    toastAction = Color(0xFF1D47B3),
    cardShadow = false,
    shadowLg = rgba(0, 0, 0, 0.5f),
)

/** Sizes from the web's custom properties and component rules. */
@Immutable
data class CaddieDimens(
    /** --appbar-h. */
    val appBarHeight: Dp = 56.dp,
    /** --nav-h. */
    val navHeight: Dp = 64.dp,
    /** --gutter: the page's side padding. */
    val gutter: Dp = 16.dp,
    /** --radius: cards, the search field, banners and toasts. */
    val radius: Dp = 12.dp,
    /**
     * The smallest visible height the web gives a control (buttons, icon buttons, links). The touch
     * target can be larger: [CaddieTheme] sets Material's minimum interactive size to the
     * platform's guideline (48 dp on Android, 44 pt on iOS), and controls reserve it with
     * minimumInteractiveComponentSize().
     */
    val minTouch: Dp = 44.dp,
    /** .chip: the visible pill; it grows with large text, and its touch target is the platform's. */
    val chipHeight: Dp = 36.dp,
    /** .search-field: the field's height at the default text size; it grows with large text. */
    val searchFieldHeight: Dp = 48.dp,
    /** The selected tab's pill behind its icon (.nav-icon). */
    val navPillWidth: Dp = 56.dp,
    val navPillHeight: Dp = 30.dp,
    /** :focus-visible outline width and offset. */
    val focusRingWidth: Dp = 2.dp,
    val focusRingOffset: Dp = 2.dp,
    /** .sheet top corners and .dialog corners. */
    val sheetRadius: Dp = 16.dp,
    val dialogRadius: Dp = 20.dp,
    /** .segmented and its segments. */
    val segmentedRadius: Dp = 10.dp,
    val segmentRadius: Dp = 8.dp,
    /** --rail-w: the side navigation rail of the wide layout. */
    val railWidth: Dp = 88.dp,
    /** The wide layout's content column (.content > * { max-width: 720px }). */
    val contentMaxWidth: Dp = 720.dp,
    /** The window width from which the wide layout applies (@media (min-width: 768px)). */
    val wideLayoutMinWidth: Dp = 768.dp,
)

/**
 * The accent blue of the web app's icon (web/public/icons), which the wide layout's rail shows at
 * its top in both themes, as the web does.
 */
val BrandBlue = Color(0xFF2457D6)

/** --motion: the duration of every state transition, in milliseconds. */
const val MOTION_MS = 180
