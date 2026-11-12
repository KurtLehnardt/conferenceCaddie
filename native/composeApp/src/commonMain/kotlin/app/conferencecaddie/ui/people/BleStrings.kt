package app.conferencecaddie.ui.people

import app.conferencecaddie.shared.ble.BlePermissionKind
import app.conferencecaddie.shared.people.PeopleText

/**
 * The copy of "Find people near me by Bluetooth" (web BleControls.tsx), word for word. The label,
 * the explanation and every problem's words come from the runtime, in the shared module's
 * `PeopleText` (BLE_LABEL, BLE_NOTICE, bleProblemMessage); this file holds only what the screens
 * add. The lines the web has no words for (which permission the phone asks for, the iPhone's
 * limits, the Settings group) are marked native.
 */
object BleStrings {
    // BleControls.tsx

    const val TURN_ON = "Turn on"
    const val STARTING = "Starting…"

    /** Under the switch while it runs. */
    const val HINT_ON =
        "Listening. You’ll get one notification when a strong match is within a few metres; it stops when being around does."

    /** Under the switch while it is off and presence is on. */
    const val HINT_OFF = "Only people who also turned this on can be found."

    // Native: the permission each platform asks for, explained in the setup panel before the
    // system prompt shows. The web leaves this to the Capacitor app's own prompt.

    /** Android 12 and newer. */
    const val PERMISSION_NEARBY_DEVICES =
        "Caddie needs the Nearby devices permission to broadcast a random code and to hear other phones that also turned this on. The code changes every 10 minutes and means nothing without our server."

    /** Android 8 to 11, where a Bluetooth scan needs the location permission. */
    const val PERMISSION_LOCATION =
        "On Android 11 and older, Android only lets an app scan for Bluetooth devices with the Location permission. Caddie never reads your position; it only listens for codes from other phones."

    /** iOS. */
    const val PERMISSION_BLUETOOTH =
        "Caddie needs the Bluetooth permission to broadcast a random code and to hear other phones that also turned this on. The code changes every 10 minutes and means nothing without our server."

    /** The setup panel's line about the permission [kind] the phone will ask for. */
    fun permissionLine(kind: BlePermissionKind): String = when (kind) {
        BlePermissionKind.NearbyDevices -> PERMISSION_NEARBY_DEVICES
        BlePermissionKind.Location -> PERMISSION_LOCATION
        BlePermissionKind.Bluetooth -> PERMISSION_BLUETOOTH
    }

    /**
     * Native, iOS only, while it runs: two iPhones with the app in the background may not find each
     * other (docs/NATIVE_PLAN.md 5.1 and 8.2), so the hint says so instead of promising more.
     */
    const val IOS_CAVEAT = "Other iPhones may find you only while one of you has Caddie open."

    /** The setup panel's explanation as a region (BleControls.tsx: role="region" aria-label). */
    const val NOTICE_LABEL = "About finding people by Bluetooth"

    /**
     * What a screen reader says for the switch: the label, then the line under it ([hint]), as the
     * web's aria-describedby="pp-ble-hint" has it read.
     */
    fun switchDescription(hint: String): String = "${PeopleText.BLE_LABEL}. $hint"

    /** Native: the heading of the Settings group that holds the same switch. */
    const val SETTINGS_GROUP = "Bluetooth"
}
