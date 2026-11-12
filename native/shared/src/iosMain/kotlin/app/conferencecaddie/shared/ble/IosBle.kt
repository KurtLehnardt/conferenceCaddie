package app.conferencecaddie.shared.ble

import app.conferencecaddie.shared.IosPeopleServices
import app.conferencecaddie.shared.core.IosCore
import app.conferencecaddie.shared.embed.OnnxRuntimeTelemetry
import kotlin.experimental.ExperimentalNativeApi

/**
 * Called from Swift (iOSApp.swift) when the app finishes launching.
 *
 * iOS relaunches an app it ended while the app was advertising or scanning with state restoration
 * (docs/NATIVE_PLAN.md 5.1), and puts `UIApplicationLaunchOptionsBluetoothCentralsKey` or
 * `...PeripheralsKey` in the launch options. Such a launch happens in the background and creates no
 * scene, so MainViewController never runs; yet Core Bluetooth expects the managers with the same
 * restore identifiers to exist again before `application(_:didFinishLaunchingWithOptions:)`
 * returns, and the common runtime has to be there to start the radio and report what it hears.
 */
object IosBle {
    private var restored = false

    /**
     * When [bluetooth] (the launch options carry one of the Bluetooth keys): recreates the radio's
     * managers at once ([IosBleRadio.resumeAfterLaunch]) and creates the core and the people
     * features exactly as MainViewController does ([IosCore.people] with [IosPeopleServices.create]),
     * whose Bluetooth runtime then resumes the radio. They are the same instances the screens use
     * if the person opens the app later. Main thread only; does nothing when [bluetooth] is false
     * or after the first call.
     *
     * The people features start out believing the app is in the foreground. A relaunch for Bluetooth
     * is in the background and has no scene, so they are told otherwise here (else they would poll
     * as if the screens were open); when the person opens the app, the scene's lifecycle effect
     * (CaddieApp's LifecycleResumeEffect) reports the foreground, after this.
     */
    @OptIn(ExperimentalNativeApi::class)
    fun restoreAfterLaunch(bluetooth: Boolean) {
        if (!bluetooth || restored) return
        restored = true
        // First, before the core or ONNX Runtime start any thread (see OnnxRuntimeTelemetry).
        OnnxRuntimeTelemetry.disableForProcess()
        IosBleRadio.shared.resumeAfterLaunch()
        val people = IosCore.people({ IosPeopleServices.create() }, allowLocalHttp = Platform.isDebugBinary)
        people.setForeground(false)
    }
}
