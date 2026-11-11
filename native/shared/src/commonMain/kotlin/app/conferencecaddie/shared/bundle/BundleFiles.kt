package app.conferencecaddie.shared.bundle

import kotlinx.io.IOException
import kotlinx.io.buffered
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.readByteArray

/**
 * Verified bundle files on disk, under `{root}/{backend key}/{content hash}/`. The backend key is
 * the first 16 hex digits of the SHA-256 of the backend base, so every backend has its own
 * directory whatever characters its URL holds. A bundle directory is written under a temporary name
 * and moved into place in one step, so a directory named by a content hash is always complete.
 */
class BundleFiles(private val root: Path) {
    private val fs = SystemFileSystem

    fun backendKey(base: String): String = Sha256.hex(base).substring(0, 16)

    private fun dir(base: String, contentHash: String) = Path(Path(root, backendKey(base)), contentHash)

    /** The files of an installed bundle, or null when any is missing or unreadable. */
    fun read(base: String, contentHash: String): Map<String, ByteArray>? = try {
        val d = dir(base, contentHash)
        BundleVerifier.BUNDLE_FILES.associateWith { name -> fs.source(Path(d, name)).buffered().use { it.readByteArray() } }
    } catch (_: Exception) {
        null
    }

    /** Stores verified [files] as the bundle [contentHash] of [base]. */
    fun write(base: String, contentHash: String, files: Map<String, ByteArray>) {
        val parent = Path(root, backendKey(base))
        fs.createDirectories(parent)
        val target = Path(parent, contentHash)
        if (fs.exists(target)) deleteTree(target)
        val temp = Path(parent, "$contentHash.partial")
        if (fs.exists(temp)) deleteTree(temp)
        fs.createDirectories(temp)
        for ((name, bytes) in files) {
            fs.sink(Path(temp, name)).buffered().use { it.write(bytes) }
        }
        fs.atomicMove(temp, target)
    }

    /** Deletes the bundle directories of [base] other than [keep], and any partial download. */
    fun prune(base: String, keep: Set<String>) {
        val parent = Path(root, backendKey(base))
        if (!fs.exists(parent)) return
        for (child in fs.list(parent)) {
            if (child.name !in keep) deleteTree(child)
        }
    }

    /** Bytes used by every stored bundle. */
    fun sizeBytes(): Long = if (fs.exists(root)) treeSize(root) else 0L

    /** Deletes every stored bundle. */
    fun clear() {
        if (fs.exists(root)) {
            for (child in fs.list(root)) deleteTree(child)
        }
    }

    // A download can create, move or delete a directory while the size is being added up, so an
    // entry that vanishes counts as empty instead of failing the whole sum.
    private fun treeSize(path: Path): Long = try {
        val meta = fs.metadataOrNull(path)
        when {
            meta == null -> 0L
            meta.isDirectory -> fs.list(path).sumOf { treeSize(it) }
            else -> meta.size
        }
    } catch (_: IOException) {
        0L
    }

    private fun deleteTree(path: Path) {
        val meta = fs.metadataOrNull(path) ?: return
        if (meta.isDirectory) {
            val children = try {
                fs.list(path)
            } catch (_: IOException) {
                emptyList()
            }
            children.forEach { deleteTree(it) }
        }
        fs.delete(path, mustExist = false)
    }
}
