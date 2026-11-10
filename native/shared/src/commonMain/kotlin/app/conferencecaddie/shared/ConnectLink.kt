package app.conferencecaddie.shared

/**
 * A `caddie://connect?url=<backend>` deep link or QR code (docs/contracts/capabilities.md, "Backend
 * URLs and switching backends"; reference `parseConnectLink()` in contracts/js/capabilities.mjs).
 *
 * A link never switches the backend by itself. [parse] returns what the confirmation screen must
 * show, and the app switches only after the person confirms a prompt that names the backend's base
 * URL exactly, origin and path. Plain http is refused, with no debug exception.
 */
sealed interface ConnectLink {
    /** A link the confirmation screen may offer. [prompt] is the question to show, verbatim. */
    data class Confirm(val backend: BackendUrl.Valid) : ConnectLink {
        val prompt: String get() = "Switch to the server at ${backend.base}?"
    }

    data class Refused(val reason: String) : ConnectLink

    companion object {
        fun parse(link: String): ConnectLink {
            val text = link.trim()
            val schemeEnd = text.indexOf("://")
            if (schemeEnd <= 0) return Refused("not_a_link")
            if (!text.substring(0, schemeEnd).equals("caddie", ignoreCase = true)) return Refused("not_a_connect_link")
            val rest = text.substring(schemeEnd + 3)
            val hostEnd = rest.indexOfFirst { it == '/' || it == '?' || it == '#' }.let { if (it < 0) rest.length else it }
            if (!rest.substring(0, hostEnd).equals("connect", ignoreCase = true)) return Refused("not_a_connect_link")
            val afterHost = rest.substring(hostEnd).substringBefore('#')
            val query = afterHost.substringAfter('?', missingDelimiterValue = "")
            val raw = query.split('&').firstOrNull { it.substringBefore('=') == "url" }?.substringAfter('=', "")
            val target = raw?.let { percentDecode(it) }
            if (target.isNullOrEmpty()) return Refused("missing_url")
            return when (val n = BackendUrl.normalise(target, allowLocalHttp = false)) {
                is BackendUrl.Valid -> Confirm(n)
                is BackendUrl.Invalid -> Refused(n.reason.code)
            }
        }

        // application/x-www-form-urlencoded decoding, as URLSearchParams does it: '+' is a space and
        // %XX is a byte of UTF-8. A malformed escape is kept as it is.
        private fun percentDecode(s: String): String {
            val bytes = ArrayList<Byte>()
            var i = 0
            while (i < s.length) {
                val c = s[i]
                when {
                    c == '+' -> { bytes += ' '.code.toByte(); i++ }
                    c == '%' && i + 2 < s.length && s.substring(i + 1, i + 3).all { it in HEX } -> {
                        bytes += s.substring(i + 1, i + 3).toInt(16).toByte()
                        i += 3
                    }
                    else -> {
                        c.toString().encodeToByteArray().forEach { bytes += it }
                        i++
                    }
                }
            }
            return bytes.toByteArray().decodeToString()
        }

        private const val HEX = "0123456789abcdefABCDEF"
    }
}
