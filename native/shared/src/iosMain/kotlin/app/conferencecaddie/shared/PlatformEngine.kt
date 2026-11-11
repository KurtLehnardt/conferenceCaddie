package app.conferencecaddie.shared.net

import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.engine.HttpClientEngineFactory
import io.ktor.client.engine.darwin.Darwin
import io.ktor.client.engine.darwin.DarwinClientEngineConfig
import platform.Foundation.NSHTTPCookieAcceptPolicy

internal actual fun platformEngine(): HttpClientEngineFactory<*> = NoCookieDarwin

/**
 * The Darwin engine (NSURLSession) without cookies. A default session configuration keeps cookies
 * in the shared cookie storage and sends them back; the app sends none, so the session neither
 * stores nor sets any.
 */
private object NoCookieDarwin : HttpClientEngineFactory<DarwinClientEngineConfig> {
    override fun create(block: DarwinClientEngineConfig.() -> Unit): HttpClientEngine = Darwin.create {
        block()
        configureSession {
            HTTPShouldSetCookies = false
            HTTPCookieAcceptPolicy = NSHTTPCookieAcceptPolicy.NSHTTPCookieAcceptPolicyNever
            HTTPCookieStorage = null
        }
    }
}
