package app.conferencecaddie.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LocalMinimumInteractiveComponentSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.unit.Dp

/** The Theme choice in Settings, as on the web (System, Light, Dark). */
enum class ThemePreference { System, Light, Dark }

val LocalCaddieColors = staticCompositionLocalOf { LightColors }
val LocalCaddieDimens = staticCompositionLocalOf { CaddieDimens() }
val LocalCaddieType = staticCompositionLocalOf { CaddieType() }

/** Shortcuts: `Caddie.colors.text2`, `Caddie.dimens.gutter`, `Caddie.type.cardTitle`. */
object Caddie {
    val colors: CaddieColors
        @Composable @ReadOnlyComposable get() = LocalCaddieColors.current
    val dimens: CaddieDimens
        @Composable @ReadOnlyComposable get() = LocalCaddieDimens.current
    val type: CaddieType
        @Composable @ReadOnlyComposable get() = LocalCaddieType.current
}

/** True when [preference] resolves to the dark theme on this device right now. */
@Composable
fun ThemePreference.isDark(): Boolean = when (this) {
    ThemePreference.System -> isSystemInDarkTheme()
    ThemePreference.Light -> false
    ThemePreference.Dark -> true
}

/**
 * The apps' theme: the web app's tokens, provided both as Caddie.colors/dimens/type and mapped onto
 * Material 3 so the Material components the apps use (text fields, switches, sheets) match.
 */
@Composable
fun CaddieTheme(preference: ThemePreference = ThemePreference.System, content: @Composable () -> Unit) {
    val dark = preference.isDark()
    val c = if (dark) DarkColors else LightColors
    val type = CaddieType()
    val scheme = if (dark) {
        darkColorScheme(
            primary = c.accent, onPrimary = c.onAccent, primaryContainer = c.accentTint, onPrimaryContainer = c.accentInk,
            secondary = c.accentInk, onSecondary = c.onAccent, secondaryContainer = c.accentTint, onSecondaryContainer = c.accentInk,
            background = c.bg, onBackground = c.text, surface = c.surface, onSurface = c.text,
            surfaceVariant = c.fill, onSurfaceVariant = c.text2, surfaceTint = c.surface,
            surfaceContainerLowest = c.bg, surfaceContainerLow = c.surface, surfaceContainer = c.surface,
            surfaceContainerHigh = c.surfaceRaised, surfaceContainerHighest = c.fillStrong,
            outline = c.borderStrong, outlineVariant = c.border, error = c.danger, onError = c.onDanger,
            errorContainer = c.dangerTint, onErrorContainer = c.danger, scrim = c.scrim,
            inverseSurface = c.toastBg, inverseOnSurface = c.toastText, inversePrimary = c.toastAction,
        )
    } else {
        lightColorScheme(
            primary = c.accent, onPrimary = c.onAccent, primaryContainer = c.accentTint, onPrimaryContainer = c.accentInk,
            secondary = c.accentInk, onSecondary = c.onAccent, secondaryContainer = c.accentTint, onSecondaryContainer = c.accentInk,
            background = c.bg, onBackground = c.text, surface = c.surface, onSurface = c.text,
            surfaceVariant = c.fill, onSurfaceVariant = c.text2, surfaceTint = c.surface,
            surfaceContainerLowest = c.bg, surfaceContainerLow = c.surface, surfaceContainer = c.surface,
            surfaceContainerHigh = c.surfaceRaised, surfaceContainerHighest = c.fillStrong,
            outline = c.borderStrong, outlineVariant = c.border, error = c.danger, onError = c.onDanger,
            errorContainer = c.dangerTint, onErrorContainer = c.danger, scrim = c.scrim,
            inverseSurface = c.toastBg, inverseOnSurface = c.toastText, inversePrimary = c.toastAction,
        )
    }
    val dimens = CaddieDimens()
    CompositionLocalProvider(
        LocalCaddieColors provides c,
        LocalCaddieDimens provides dimens,
        LocalCaddieType provides type,
        // Controls reserve the platform's minimum touch target with minimumInteractiveComponentSize().
        LocalMinimumInteractiveComponentSize provides PlatformTouchTarget,
    ) {
        MaterialTheme(
            colorScheme = scheme,
            typography = materialTypography(type),
            shapes = Shapes(
                extraSmall = RoundedCornerShape(dimens.segmentRadius),
                small = RoundedCornerShape(dimens.segmentedRadius),
                medium = RoundedCornerShape(dimens.radius),
                large = RoundedCornerShape(dimens.sheetRadius),
                extraLarge = RoundedCornerShape(dimens.dialogRadius),
            ),
        ) {
            SystemBarsAppearance(preference, dark)
            content()
        }
    }
}

/**
 * Makes the status and navigation bar icons readable on the theme's background: dark icons on the
 * light theme, light icons on the dark one. The app draws behind the system bars on both platforms.
 * [preference] is the Theme setting and [dark] what it resolved to.
 */
@Composable
internal expect fun SystemBarsAppearance(preference: ThemePreference, dark: Boolean)

/** The platform's minimum touch target: 48 dp on Android, 44 pt on iOS. */
internal expect val PlatformTouchTarget: Dp
