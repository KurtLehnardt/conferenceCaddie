package app.conferencecaddie.shared.net

import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.engine.HttpClientEngineFactory
import io.ktor.client.engine.darwin.Darwin
import io.ktor.client.engine.darwin.DarwinClientEngineConfig
import platform.Foundation.NSHTTPCookieAcceptPolicy

internal actual fun platformEngine(): HttpClientEngineFactory<*> = NoCookieDarwin

/**
 * The Darwin engine (NSURLSession) without cookies and without a URL cache. A default session
 * configuration keeps cookies in the shared cookie storage and sends them back; the app sends none,
 * so the session neither stores nor sets any. It also stores answers in the shared URL cache, on
 * disk; Ktor asks each request to ignore the cache, but that does not stop an answer from being
 * stored, so the session has no cache at all and no People API answer (an inbox, a block list, a
 * meet) is written to disk by the system. The bundle code keeps its own copies and ETags, as on
 * Android, where OkHttp has no cache configured.
 */
private object NoCookieDarwin : HttpClientEngineFactory<DarwinClientEngineConfig> {
    override fun create(block: DarwinClientEngineConfig.() -> Unit): HttpClientEngine = Darwin.create {
        block()
        configureSession {
            HTTPShouldSetCookies = false
            HTTPCookieAcceptPolicy = NSHTTPCookieAcceptPolicy.NSHTTPCookieAcceptPolicyNever
            HTTPCookieStorage = null
            URLCache = null
        }
    }
}
