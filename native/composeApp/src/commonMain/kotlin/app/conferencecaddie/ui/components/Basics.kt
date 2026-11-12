package app.conferencecaddie.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.icons.vector
import app.conferencecaddie.ui.theme.Caddie
import app.conferencecaddie.ui.theme.minimumTouchTarget

/** The pill shape of buttons, chips and badges (border-radius: 999px). */
val Pill: Shape = RoundedCornerShape(percent = 50)

/**
 * A lucide icon. [contentDescription] is null for a decorative icon next to text, as the web marks
 * those aria-hidden.
 */
@Composable
fun LucideImage(
    icon: LucideIcon,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    size: Dp = 24.dp,
    tint: Color = Caddie.colors.text2,
    strokeWidth: Float = 2f,
    filled: Boolean = false,
) {
    Icon(icon.vector(strokeWidth, filled), contentDescription, modifier.size(size), tint = tint)
}

/**
 * The web's :focus-visible ring: a 2 dp accent outline while the element has keyboard focus. Touch
 * input does not focus these elements, so the ring shows only for keyboards and switch access.
 */
@Composable
fun Modifier.focusRing(interactionSource: MutableInteractionSource, shape: Shape): Modifier {
    val focused by interactionSource.collectIsFocusedAsState()
    return if (focused) this.border(Caddie.dimens.focusRingWidth, Caddie.colors.accent, shape) else this
}

/** A clickable area with the platform ripple and the web's focus ring. */
@Composable
fun Modifier.caddieClickable(
    shape: Shape,
    role: Role = Role.Button,
    enabled: Boolean = true,
    onClickLabel: String? = null,
    onClick: () -> Unit,
): Modifier {
    val interaction = remember { MutableInteractionSource() }
    return this
        .focusRing(interaction, shape)
        .clip(shape)
        .clickable(
            interactionSource = interaction,
            indication = ripple(),
            enabled = enabled,
            role = role,
            onClickLabel = onClickLabel,
            onClick = onClick,
        )
}

enum class ButtonVariant { Primary, Tonal, Text, Danger }

/**
 * .btn: a pill button at least 44 dp tall (.btn-primary, -tonal, -text, -danger; .btn-small). Its
 * touch target is at least the platform's minimum (48 dp on Android, 44 pt on iOS). [icon] goes
 * before the label, filled when [iconFilled] (the star of an "Interested" button), and
 * [trailingIcon] after it (a chevron that opens or closes something), both [iconSize]: 18 dp, or
 * 16 dp on a small button, as the web draws them.
 */
@Composable
fun CaddieButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    variant: ButtonVariant = ButtonVariant.Primary,
    small: Boolean = false,
    enabled: Boolean = true,
    icon: LucideIcon? = null,
    iconFilled: Boolean = false,
    trailingIcon: LucideIcon? = null,
    iconSize: Dp = if (small) 16.dp else 18.dp,
) {
    val c = Caddie.colors
    val (bg, fg) = when (variant) {
        ButtonVariant.Primary -> c.accent to c.onAccent
        ButtonVariant.Tonal -> c.accentTint to c.accentInk
        ButtonVariant.Text -> Color.Transparent to c.accentInk
        ButtonVariant.Danger -> c.danger to c.onDanger
    }
    Row(
        modifier
            .minimumTouchTarget()
            .alpha(if (enabled) 1f else 0.45f)
            .heightIn(min = Caddie.dimens.minTouch)
            .caddieClickable(Pill, enabled = enabled, onClick = onClick)
            .background(bg, Pill)
            .padding(horizontal = if (small) 14.dp else 20.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
    ) {
        if (icon != null) LucideImage(icon, null, size = iconSize, tint = fg, filled = iconFilled)
        // The web keeps a button on one line; here a long label may wrap instead, so it stays
        // readable at large system font sizes.
        Text(
            text,
            style = if (small) Caddie.type.buttonSmall else Caddie.type.button,
            color = fg,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(vertical = 6.dp),
        )
        if (trailingIcon != null) LucideImage(trailingIcon, null, size = iconSize, tint = fg)
    }
}

/**
 * .icon-btn: a 44 dp round button holding one icon, named by [contentDescription]. Its touch target
 * is at least the platform's minimum.
 */
@Composable
fun CaddieIconButton(
    icon: LucideIcon,
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    iconSize: Dp = 24.dp,
    tint: Color = Caddie.colors.text2,
    badge: Int = 0,
) {
    Box(
        modifier
            .minimumTouchTarget()
            .size(Caddie.dimens.minTouch)
            .caddieClickable(CircleShape, onClick = onClick)
            .semantics { this.contentDescription = contentDescription },
        contentAlignment = Alignment.Center,
    ) {
        LucideImage(icon, null, size = iconSize, tint = tint)
        if (badge > 0) {
            // .appbar-inbox .nav-badge: 4 dp from the top and 24 dp from the left of the 44 dp
            // button, growing to the right, with the surface-coloured ring.
            Badge(badge, Modifier.align(Alignment.TopStart).offset(x = 24.dp, y = 4.dp), ring = Caddie.colors.surface)
        }
    }
}

/** The text of a count badge: the number, or "99+" above 99, as on the web. */
fun badgeText(count: Int): String = if (count > 99) "99+" else count.toString()

/**
 * .badge: a count in an accent pill; the parent element carries the count in its accessible name.
 * [ring] draws the 2 dp ring of .nav-badge (box-shadow: 0 0 0 2px) around the pill, outside its
 * bounds, so the badge stands out where it overlaps an icon.
 */
@Composable
fun Badge(count: Int, modifier: Modifier = Modifier, ring: Color? = null) {
    val c = Caddie.colors
    Box(
        modifier
            .clearAndSetSemantics { }
            .defaultMinSize(minWidth = 18.dp, minHeight = 18.dp)
            .widthIn(min = 18.dp)
            .then(
                if (ring != null) {
                    Modifier.drawBehind {
                        val r = 2.dp.toPx()
                        drawRoundRect(
                            color = ring,
                            topLeft = Offset(-r, -r),
                            size = Size(size.width + 2 * r, size.height + 2 * r),
                            cornerRadius = CornerRadius(size.height / 2 + r),
                        )
                    }
                } else {
                    Modifier
                },
            )
            .background(c.accent, Pill)
            .padding(horizontal = 5.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(badgeText(count), style = Caddie.type.badge, color = c.onAccent)
    }
}
