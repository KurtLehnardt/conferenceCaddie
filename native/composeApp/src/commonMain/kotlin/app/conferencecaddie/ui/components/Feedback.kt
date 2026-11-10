package app.conferencecaddie.ui.components

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie
import kotlinx.coroutines.delay

/** A button inside a state, banner or toast. */
data class StateAction(val label: String, val onClick: () -> Unit, val icon: LucideIcon? = null)

/**
 * .state: the centred empty, error and offline states. Each part is optional: a 40 dp icon at 70%
 * opacity, a title, a body, a tonal [action] and a [hint] under it.
 */
@Composable
fun StateView(
    modifier: Modifier = Modifier,
    icon: LucideIcon? = null,
    title: String? = null,
    body: String? = null,
    action: StateAction? = null,
    hint: (@Composable () -> Unit)? = null,
) {
    val c = Caddie.colors
    Column(
        modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 56.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (icon != null) LucideImage(icon, null, Modifier.alpha(0.7f), size = 40.dp)
        if (title != null) {
            Text(title, style = Caddie.type.stateTitle, color = c.text, textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() })
        }
        if (body != null) {
            Text(body, style = Caddie.type.stateBody, color = c.text2, textAlign = TextAlign.Center, modifier = Modifier.widthIn(max = 320.dp))
        }
        if (action != null) CaddieButton(action.label, action.onClick, variant = ButtonVariant.Tonal, icon = action.icon)
        if (hint != null) Box(Modifier.widthIn(max = 320.dp)) { hint() }
    }
}

/** .banner: an error line on the danger tint with an optional Retry, announced when it appears. */
@Composable
fun ErrorBanner(message: String, modifier: Modifier = Modifier, onRetry: (() -> Unit)? = null) {
    val c = Caddie.colors
    Row(
        modifier
            .fillMaxWidth()
            .padding(horizontal = Caddie.dimens.gutter)
            .padding(bottom = 12.dp)
            .background(c.dangerTint, RoundedCornerShape(Caddie.dimens.radius))
            .padding(start = 12.dp, top = 4.dp, bottom = 4.dp, end = 4.dp)
            .heightIn(min = 36.dp)
            .semantics { liveRegion = LiveRegionMode.Assertive },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        LucideImage(LucideIcon.CircleExclamationPoint, null, size = 18.dp, tint = c.danger)
        Text(message, style = Caddie.type.meta, color = c.danger, modifier = Modifier.weight(1f))
        if (onRetry != null) CaddieButton(Strings.Common.RETRY, onRetry, variant = ButtonVariant.Text, small = true)
    }
}

/** A quiet note line (.degraded-note, .now-note, .footnote). */
@Composable
fun NoteText(text: String, modifier: Modifier = Modifier, center: Boolean = false) {
    Text(
        text,
        style = Caddie.type.note,
        color = Caddie.colors.text2,
        textAlign = if (center) TextAlign.Center else TextAlign.Start,
        modifier = modifier.fillMaxWidth().padding(horizontal = Caddie.dimens.gutter),
    )
}

/** .offline-badge: "Offline" with the wifi-off icon, in the app bar. */
@Composable
fun OfflineBadge(modifier: Modifier = Modifier) {
    val c = Caddie.colors
    Row(
        modifier
            .padding(end = 4.dp)
            .background(c.fill, Pill)
            .padding(horizontal = 8.dp, vertical = 3.dp)
            .semantics { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        LucideImage(LucideIcon.WifiOff, null, size = 14.dp)
        Text(Strings.Offline.BADGE, style = Caddie.type.navLabel.copy(fontWeight = Caddie.type.button.fontWeight), color = c.text2)
    }
}

/** .offline-label: "Offline: keyword search only" above offline results. */
@Composable
fun OfflineLabel(modifier: Modifier = Modifier, text: String = Strings.Offline.LABEL) {
    Row(
        modifier.padding(horizontal = Caddie.dimens.gutter).padding(top = 4.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        LucideImage(LucideIcon.WifiOff, null, size = 16.dp)
        Text(text, style = Caddie.type.buttonSmall, color = Caddie.colors.text2)
    }
}

/** NeedsConnection: the calm state for a screen that needs the server while offline. */
@Composable
fun NeedsConnection(title: String, body: String = Strings.Offline.NEEDS_CONNECTION_BODY, modifier: Modifier = Modifier) {
    StateView(modifier.semantics { liveRegion = LiveRegionMode.Polite }, icon = LucideIcon.WifiOff, title = title, body = body)
}

/** A short message with an optional action, as the web's toast. */
data class ToastData(val id: Long, val message: String, val actionLabel: String? = null)

/**
 * .toast: a dark bar above the tab bar that dismisses itself after five seconds, as on the web.
 * [onAction] runs the action and the toast then closes.
 */
@Composable
fun Toast(toast: ToastData, onDismiss: () -> Unit, onAction: () -> Unit, modifier: Modifier = Modifier) {
    val c = Caddie.colors
    LaunchedEffect(toast.id) {
        delay(5_000)
        onDismiss()
    }
    Row(
        modifier
            .fillMaxWidth()
            .padding(horizontal = Caddie.dimens.gutter)
            .widthIn(max = 560.dp)
            .shadow(8.dp, RoundedCornerShape(Caddie.dimens.radius), ambientColor = c.shadowLg, spotColor = c.shadowLg)
            .background(c.toastBg, RoundedCornerShape(Caddie.dimens.radius))
            .heightIn(min = 48.dp)
            .padding(start = 16.dp, top = 4.dp, bottom = 4.dp, end = 4.dp)
            .semantics { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(toast.message, style = Caddie.type.toast, color = c.toastText, modifier = Modifier.weight(1f))
        if (toast.actionLabel != null) {
            Box(
                Modifier.heightIn(min = 44.dp).caddieClickable(RoundedCornerShape(8.dp)) {
                    onAction()
                    onDismiss()
                }.padding(horizontal = 14.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(toast.actionLabel, style = Caddie.type.button.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.Bold), color = c.toastAction)
            }
        }
    }
}

/** .card.skeleton: a pulsing placeholder card while results load. */
@Composable
fun SkeletonCard(modifier: Modifier = Modifier) {
    val c = Caddie.colors
    val transition = rememberInfiniteTransition()
    val pulse by transition.animateFloat(1f, 0.5f, infiniteRepeatable(tween(600), RepeatMode.Reverse))
    Column(
        modifier
            .fillMaxWidth()
            .background(c.surface, RoundedCornerShape(Caddie.dimens.radius))
            .padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 16.dp)
            .alpha(pulse),
    ) {
        Box(Modifier.fillMaxWidth(0.75f).height(18.dp).padding(top = 4.dp).background(c.fill, RoundedCornerShape(6.dp)))
        Box(Modifier.fillMaxWidth(0.4f).padding(top = 10.dp).height(12.dp).background(c.fill, RoundedCornerShape(6.dp)))
        Box(Modifier.fillMaxWidth().padding(top = 10.dp).height(12.dp).background(c.fill, RoundedCornerShape(6.dp)))
        Box(Modifier.fillMaxWidth(0.6f).padding(top = 10.dp).height(12.dp).background(c.fill, RoundedCornerShape(6.dp)))
    }
}
