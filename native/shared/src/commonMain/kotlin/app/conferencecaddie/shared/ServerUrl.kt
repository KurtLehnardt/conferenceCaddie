package app.conferencecaddie.shared

/**
 * The backend origin the app talks to, as typed in Settings → Server. Normalising it in one place
 * keeps per-origin secrets (see [SecureStore]) from being split across "https://x" and "https://x/".
 */
object ServerUrl {
    sealed interface Result {
        data class Valid(val origin: String) : Result
        data class Invalid(val reason: String) : Result
    }

    /**
     * Trims the input, assumes https when no scheme is given, rejects anything that is not http or
     * https, and drops trailing slashes. A path is kept, because a tier 1 bundle can live under one
     * (for example a GitHub Pages project site).
     */
    fun normalize(input: String): Result {
        val trimmed = input.trim()
        if (trimmed.isEmpty()) return Result.Invalid("Enter the server address.")
        if (trimmed.any { it.isWhitespace() }) return Result.Invalid("The address cannot contain spaces.")

        val schemeEnd = trimmed.indexOf("://")
        val withScheme = if (schemeEnd < 0) "https://$trimmed" else trimmed
        val scheme = withScheme.substringBefore("://").lowercase()
        if (scheme != "https" && scheme != "http") {
            return Result.Invalid("Use an http or https address.")
        }

        val rest = withScheme.substringAfter("://").trimEnd('/')
        val host = rest.substringBefore('/').substringBefore('?').substringBefore('#')
        if (host.isEmpty()) return Result.Invalid("The address has no host name.")

        val path = rest.removePrefix(host)
        return Result.Valid("$scheme://${host.lowercase()}$path")
    }
}
