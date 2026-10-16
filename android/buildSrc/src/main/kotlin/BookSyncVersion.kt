/**
 * App version from the release tag, like the server and the extension:
 * BOOKSYNC_VERSION=X.Y.Z or X.Y.Z-rc.N. Builds that are not from a tag get
 * 0.0.0-dev and versionCode 1.
 *
 * versionCode = X*1_000_000 + Y*10_000 + Z*100 + (N for rc.N, 99 for the
 * release), so every rc sorts before its release and after the previous one.
 */
object BookSyncVersion {
    const val DEV_NAME = "0.0.0-dev"
    private val pattern = Regex("""^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$""")

    fun name(env: String?): String {
        val v = env?.trim()?.removePrefix("v").orEmpty()
        return if (pattern.matches(v) && code(v) > 1) v else DEV_NAME
    }

    fun code(name: String): Int {
        val m = pattern.matchEntire(name) ?: return 1
        val (x, y, z, rc) = m.destructured
        val major = x.toInt()
        val minor = y.toInt()
        val patch = z.toInt()
        val pre = if (rc.isEmpty()) 99 else rc.toInt()
        if (minor > 99 || patch > 99 || pre !in 1..99 || major > 2000) return 1
        return major * 1_000_000 + minor * 10_000 + patch * 100 + pre
    }
}
