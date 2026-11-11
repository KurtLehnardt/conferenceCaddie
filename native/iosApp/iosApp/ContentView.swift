import ComposeApp
import SwiftUI
import UIKit

/// Hosts the Compose Multiplatform UI (composeApp's MainViewController) inside SwiftUI.
struct ComposeView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> UIViewController {
        MainViewControllerKt.MainViewController()
    }

    func updateUIViewController(_ uiViewController: UIViewController, context: Context) {}
}

struct ContentView: View {
    var body: some View {
        ComposeView()
            .ignoresSafeArea()
            // A caddie:// link (a QR code, another app) or a schedule file opened in the app ("Open
            // in", "Copy to Conference Caddie") goes to the shared code, which checks it.
            .onOpenURL { url in
                IosIncomingKt.openIncomingUrl(url: url)
            }
    }
}
