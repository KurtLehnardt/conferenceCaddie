package app.conferencecaddie

import androidx.test.ext.junit.runners.AndroidJUnit4
import app.conferencecaddie.shared.LocationAccess
import app.conferencecaddie.shared.decideAccess
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/** When the location provider concludes "refused for good": only from a system answer with no rationale left. */
@RunWith(AndroidJUnit4::class)
class LocationAccessDecisionTest {
    @Test
    fun grantedPermissionsWinOverTheRest() {
        assertEquals(LocationAccess.Precise, decideAccess(fine = true, coarse = true, asked = false, rationale = null))
        assertEquals(LocationAccess.Approximate, decideAccess(fine = false, coarse = true, asked = true, rationale = false))
    }

    @Test
    fun neverAnsweredMeansNotAsked() {
        assertEquals(LocationAccess.NotAsked, decideAccess(fine = false, coarse = false, asked = false, rationale = false))
    }

    @Test
    fun aRefusalWithARationaleLeftMeansAskAgain() {
        assertEquals(LocationAccess.NotAsked, decideAccess(fine = false, coarse = false, asked = true, rationale = true))
    }

    @Test
    fun noActivityMeansNothingIsKnownSoNotAsked() {
        assertEquals(LocationAccess.NotAsked, decideAccess(fine = false, coarse = false, asked = true, rationale = null))
    }

    @Test
    fun answeredWithNoRationaleLeftMeansRefusedForGood() {
        assertEquals(LocationAccess.Denied, decideAccess(fine = false, coarse = false, asked = true, rationale = false))
    }
}
