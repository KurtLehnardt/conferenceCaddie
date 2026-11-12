package app.conferencecaddie.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.dp
import app.conferencecaddie.shared.Demo
import app.conferencecaddie.ui.theme.Caddie

// The "Demo" label of a demo conference (web/src/components/demo.tsx): one pill, drawn wherever the
// conference's data shows (the app bar, the switcher, talk cards and the talk sheet), and the note
// at the top of each screen of the conference. Its words are the shared module's Demo, so the
// apps and the web say the same thing.

/**
 * True when the screens should label [demo] data: only a conference entry with `"demo": true`
 * ([app.conferencecaddie.shared.bundle.Conference.demo]) is one. A helper rather than a field read,
 * so each place that decides whether to draw the pill says so in one way.
 */
fun showsDemoLabel(demo: Boolean?): Boolean = demo == true

/**
 * .demo-pill: "DEMO" in the accent ink on the accent tint, with an accent border, exactly as the
 * Sample pill of a sample profile ([app.conferencecaddie.ui.people.SamplePill]) is drawn. Screen
 * readers hear "Demo conference, invented data"; a control that already says so in its own
 * description passes [spoken] false, so it is not heard twice.
 */
@Composable
fun DemoPill(modifier: Modifier = Modifier, spoken: Boolean = true) {
    val c = Caddie.colors
    Box(
        modifier
            .testTag(DEMO_PILL_TAG)
            .background(c.accentTint, Pill)
            .border(1.dp, c.accentInk, Pill)
            .padding(horizontal = 10.dp, vertical = 2.dp)
            .clearAndSetSemantics { if (spoken) contentDescription = Demo.SPOKEN },
    ) {
        Text(Demo.LABEL.uppercase(), style = Caddie.type.peopleSample, color = c.accentInk, maxLines = 1)
    }
}

/**
 * .demo-note: the pill and "A demo conference with invented talks and speakers, not a real event."
 * in the note style (13, secondary text), 8 dp apart. Drawn at the top of a screen of a demo
 * conference; [demo] false draws nothing.
 */
@Composable
fun DemoNote(demo: Boolean, modifier: Modifier = Modifier) {
    if (!showsDemoLabel(demo)) return
    Row(
        modifier.fillMaxWidth().testTag(DEMO_NOTE_TAG),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        DemoPill()
        Text(Demo.NOTE, style = Caddie.type.note, color = Caddie.colors.text2, modifier = Modifier.weight(1f))
    }
}

/** The test tag of every [DemoPill]. */
const val DEMO_PILL_TAG = "demo-pill"

/** The test tag of every [DemoNote]. */
const val DEMO_NOTE_TAG = "demo-note"
