package app.conferencecaddie.ui

import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import app.conferencecaddie.ui.components.isNarrowerThan
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

// The app bar's narrow rule (web: @media (max-width: 359px)) compares whole pixels, as the layout
// does: a window exactly 360 dp wide is never narrow, at any density, the lowered ones of the test
// phone included.
class NarrowLayoutTest {
    @Test
    fun aWindowOf360DpIsNotNarrowAndOnePixelLessIs() {
        for (scale in listOf(1f, 2f, 2.625f, 3f, 0.8875f, 1.3333f)) {
            val density = Density(scale)
            val px = with(density) { 360.dp.roundToPx() }
            assertFalse(isNarrowerThan(px, 360.dp, density), "360 dp at $scale")
            assertTrue(isNarrowerThan(px - 1, 360.dp, density), "one pixel under 360 dp at $scale")
        }
        assertTrue(isNarrowerThan(with(Density(3f)) { 320.dp.roundToPx() }, 360.dp, Density(3f)))
        assertFalse(isNarrowerThan(with(Density(3f)) { 390.dp.roundToPx() }, 360.dp, Density(3f)))
    }
}
