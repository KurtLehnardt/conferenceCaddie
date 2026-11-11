import ComposeApp
import SwiftUI
import UIKit
import UserNotifications

@main
struct iOSApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

/// The UIKit callbacks SwiftUI does not offer: the launch options, the APNs device token and
/// notification taps. Each one is handed straight to the shared Kotlin code (IosBle, IosPush,
/// IosNotificationTaps).
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Set before launch finishes, so a tap that launched the app is not missed.
        UNUserNotificationCenter.current().delegate = self
        // iOS relaunched the app in the background for Bluetooth state restoration: no scene (and so
        // no MainViewController) is created, but the Bluetooth managers must exist again before this
        // method returns, and the people features must run to start the radio (IosBle.kt).
        let bluetooth = launchOptions?[.bluetoothCentrals] != nil || launchOptions?[.bluetoothPeripherals] != nil
        IosBle.shared.restoreAfterLaunch(bluetooth: bluetooth)
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        IosPush.shared.didRegister(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        IosPush.shared.didFail(error: error as NSError)
    }

    /// Notifications that arrive while the app is open are shown too, as on Android.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
    }

    /// A tap hands the notification's caddie:// link to the screens.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
            IosNotificationTaps.shared.didReceive(userInfo: response.notification.request.content.userInfo)
        }
        completionHandler()
    }
}
