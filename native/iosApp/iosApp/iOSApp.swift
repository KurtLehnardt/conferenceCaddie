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

/// The UIKit callbacks SwiftUI does not offer: the APNs device token and notification taps. Each
/// one is handed straight to the Kotlin code (IosPush; openNotificationTap, which reads the link
/// with IosNotificationTaps and hands it over like any other caddie:// link).
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Set before launch finishes, so a tap that launched the app is not missed.
        UNUserNotificationCenter.current().delegate = self
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

    /// A tap hands the notification's caddie:// link to the app's link router, as onOpenURL does
    /// with a link from another app. A tap that launches the app arrives here before the screens
    /// exist; the hand-off keeps the link until they take it.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
            IosIncomingKt.openNotificationTap(userInfo: response.notification.request.content.userInfo)
        }
        completionHandler()
    }
}
