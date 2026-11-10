package app.conferencecaddie.shared

/**
 * A backend URL as the user types it in Settings → Server, checked and normalised by the rules of
 * the capabilities contract (docs/contracts/capabilities.md, "Backend URLs and switching
 * backends"; reference implementation `normaliseBackendUrl()` in contracts/js/capabilities.mjs).
 *
 * - Only `https` is accepted. With `allowLocalHttp` (debug builds, and only for a URL typed in
 *   Settings, never one from a link or QR code), plain `http` to localhost, 127.0.0.1, [::1] and
 *   10.0.2.2 is accepted too.
 * - Credentials (`user:pw@`), a query and a fragment are refused.
 * - The scheme and host are lowercased, the default port is dropped, and the path is kept without
 *   trailing slashes, because a tier 1 site lives under `/<repo>`.
 *
 * The reference implementation uses the WHATWG URL parser. This parser accepts the same
 * well-formed URLs and gives the same `base` and `origin` for them, and the reasons are checked in
 * the same order. It is stricter in a few places, all of which make it return [Reason.NotAUrl] (or
 * [Reason.QueryNotAllowed] for an empty `?` or `#`, and [Reason.CredentialsNotAllowed] for an empty
 * `@`) where WHATWG would quietly repair the input:
 * whitespace, control characters or backslashes anywhere (WHATWG reads `\` as `/`, a known way to
 * disguise the host); a missing or extra slash after the scheme; `.` or `..` path segments;
 * characters WHATWG would percent-encode; non-ASCII hosts and underscores in host names; and any
 * IPv6 literal other than `[::1]`.
 *
 * IPv4 follows WHATWG's rule for when a host is an address: when the last label is a decimal number
 * or `0x` followed by hex digits, the host is IPv4. WHATWG then rewrites shorthand such as `127.1`,
 * `0x7f000001`, `1.2.3.0x4` or `01.2.3.4` to a dotted quad and drops a trailing dot; here only a
 * canonical dotted quad without a trailing dot is accepted. A host such as `example.0x1`, which
 * WHATWG refuses, is refused too.
 */
sealed interface BackendUrl {
    /**
     * An accepted backend. [base] is the URL the app calls (`{base}/api/...`), the one a
     * confirmation prompt names, and the key for everything stored per backend; [origin] is the
     * scheme, host and port.
     */
    @ConsistentCopyVisibility
    data class Valid internal constructor(val base: String, val origin: String) : BackendUrl

    data class Invalid(val reason: Reason) : BackendUrl

    /** Why a URL was refused; [code] is the reason string the contract uses. */
    enum class Reason(val code: String) {
        NotAUrl("not_a_url"),
        HttpsRequired("https_required"),
        CredentialsNotAllowed("credentials_not_allowed"),
        QueryNotAllowed("query_not_allowed"),
    }

    companion object {
        private val LOCAL_HOSTS = setOf("localhost", "127.0.0.1", "10.0.2.2", "[::1]")
        private val SCHEME = Regex("[A-Za-z][A-Za-z0-9+.-]*")
        private val HOST_CHARS = Regex("[a-z0-9.-]+")
        private val IPV4_NUMBER = Regex("0[xX][0-9a-fA-F]*|[0-9]+")
        private const val PATH_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789" +
            "-._~!$&'()*+,;=:@/%"
        private val DOT_SEGMENTS = setOf(".", "..", "%2e", ".%2e", "%2e.", "%2e%2e")

        fun normalise(input: String, allowLocalHttp: Boolean = false): BackendUrl {
            val text = input.trim()
            if (text.isEmpty() || text.any { it.isWhitespace() || it.isISOControl() || it == '\\' }) {
                return Invalid(Reason.NotAUrl)
            }

            val colon = text.indexOf(':')
            if (colon <= 0 || !SCHEME.matches(text.substring(0, colon))) return Invalid(Reason.NotAUrl)
            val scheme = text.substring(0, colon).lowercase()
            // Any other scheme that parses (ftp:, javascript:, data: ...) is refused as not https,
            // as the reference implementation does.
            if (scheme != "https" && scheme != "http") return Invalid(Reason.HttpsRequired)

            val afterScheme = text.substring(colon + 1)
            if (!afterScheme.startsWith("//") || afterScheme.startsWith("///")) return Invalid(Reason.NotAUrl)
            val rest = afterScheme.substring(2)
            val authorityEnd = rest.indexOfFirst { it == '/' || it == '?' || it == '#' }
                .let { if (it < 0) rest.length else it }
            val authority = rest.substring(0, authorityEnd)
            val tail = rest.substring(authorityEnd)

            // As in WHATWG, the last '@' ends the credentials, so "https://good.example@evil.example"
            // is a URL for evil.example with credentials, and is refused below.
            val at = authority.lastIndexOf('@')
            val hasCredentials = at >= 0
            val hostPort = parseHostPort(if (at >= 0) authority.substring(at + 1) else authority)
                ?: return Invalid(Reason.NotAUrl)

            val queryStart = tail.indexOfFirst { it == '?' || it == '#' }
            val hasQuery = queryStart >= 0
            val path = if (hasQuery) tail.substring(0, queryStart) else tail
            if (!validPath(path)) return Invalid(Reason.NotAUrl)

            val local = hostPort.host in LOCAL_HOSTS
            if (scheme != "https" && !(allowLocalHttp && local)) return Invalid(Reason.HttpsRequired)
            if (hasCredentials) return Invalid(Reason.CredentialsNotAllowed)
            if (hasQuery) return Invalid(Reason.QueryNotAllowed)

            val defaultPort = if (scheme == "https") 443 else 80
            val port = hostPort.port?.takeIf { it != defaultPort }?.let { ":$it" } ?: ""
            val origin = "$scheme://${hostPort.host}$port"
            return Valid(base = origin + path.trimEnd('/'), origin = origin)
        }

        private class HostPort(val host: String, val port: Int?)

        private fun parseHostPort(text: String): HostPort? {
            if (text.isEmpty()) return null
            val host: String
            val portText: String?
            if (text.startsWith("[")) {
                val close = text.indexOf(']')
                if (close < 0) return null
                host = text.substring(0, close + 1).lowercase()
                if (host != "[::1]") return null
                val after = text.substring(close + 1)
                portText = when {
                    after.isEmpty() -> null
                    after.startsWith(":") -> after.substring(1)
                    else -> return null
                }
            } else {
                val colon = text.indexOf(':')
                if (colon >= 0 && text.indexOf(':', colon + 1) >= 0) return null
                host = (if (colon >= 0) text.substring(0, colon) else text).lowercase()
                portText = if (colon >= 0) text.substring(colon + 1) else null
                if (!validHost(host)) return null
            }
            val port = when {
                portText.isNullOrEmpty() -> null
                portText.all { it in '0'..'9' } -> {
                    val digits = portText.trimStart('0').ifEmpty { "0" }
                    if (digits.length > 5) return null
                    digits.toInt().takeIf { it <= 65535 } ?: return null
                }
                else -> return null
            }
            return HostPort(host, port)
        }

        private fun validHost(host: String): Boolean {
            if (host.isEmpty() || host.length > 253 || !HOST_CHARS.matches(host)) return false
            val labels = host.removeSuffix(".").split('.')
            if (labels.any { it.isEmpty() }) return false
            // WHATWG reads a host whose last label is a number (decimal, or 0x and hex digits) as
            // IPv4, rewrites shorthand forms and drops a trailing dot; only the canonical dotted quad
            // without a trailing dot is accepted here, so the base never differs from the reference.
            if (IPV4_NUMBER.matches(labels.last())) {
                return !host.endsWith(".") && labels.size == 4 && labels.all { label ->
                    label.all { it in '0'..'9' } && label.length <= 3 &&
                        (label == "0" || !label.startsWith("0")) && label.toInt() <= 255
                }
            }
            return true
        }

        private fun validPath(path: String): Boolean {
            if (path.isEmpty()) return true
            if (!path.startsWith("/") || path.any { it !in PATH_CHARS }) return false
            var i = path.indexOf('%')
            while (i >= 0) {
                if (i + 2 >= path.length || !path[i + 1].isHexDigit() || !path[i + 2].isHexDigit()) return false
                i = path.indexOf('%', i + 1)
            }
            return path.split('/').none { it.lowercase() in DOT_SEGMENTS }
        }

        private fun Char.isHexDigit(): Boolean = this in '0'..'9' || this in 'a'..'f' || this in 'A'..'F'
    }
}
