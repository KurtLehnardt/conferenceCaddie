package app.conferencecaddie

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.conferencecaddie.shared.AndroidSecureStore
import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.SecureStore
import java.io.File
import java.security.KeyStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The Keystore-backed secure store on a real device or emulator, with a file and a Keystore key of
 * its own, so the app's store is never touched. Run it with
 * `./gradlew :androidApp:connectedDebugAndroidTest`.
 */
@RunWith(AndroidJUnit4::class)
class AndroidSecureStoreTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val file = "caddie_secure_store_test"
    private val alias = "caddie-secure-store-test"
    private val official = backend("https://caddie.example.org")
    private val other = backend("https://caddie.example.org/other")
    private val secretKey = SecureStore.scopedKey(official, "device")
    private val otherKey = SecureStore.scopedKey(other, "device")
    private val secret = "profile-id.c2VjcmV0LXZhbHVlLXRoYXQtbXVzdC1zdGF5LWhpZGRlbg"

    private fun backend(url: String) = BackendUrl.normalise(url) as BackendUrl.Valid

    private fun store() = AndroidSecureStore(context, fileName = file, keyAlias = alias)

    private fun prefsFile() = File(context.dataDir, "shared_prefs/$file.xml")

    private fun clean() {
        context.deleteSharedPreferences(file)
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(alias)
    }

    @Before
    fun setUp() = clean()

    @After
    fun tearDown() = clean()

    @Test
    fun aValueRoundTripsAndSurvivesANewInstance() = runBlocking {
        store().put(secretKey, secret)
        assertEquals(secret, store().get(secretKey))
    }

    @Test
    fun aMissingKeyReadsAsNull() = runBlocking {
        assertNull(store().get(secretKey))
    }

    @Test
    fun putOverwrites() = runBlocking {
        val store = store()
        store.put(secretKey, "first")
        store.put(secretKey, "second")
        assertEquals("second", store.get(secretKey))
    }

    @Test
    fun removeForgetsTheValue() = runBlocking {
        val store = store()
        store.put(secretKey, secret)
        store.remove(secretKey)
        assertNull(store.get(secretKey))
        store.remove(secretKey)
    }

    @Test
    fun twoBackendsKeepTheirOwnValues() = runBlocking {
        val store = store()
        store.put(secretKey, "official")
        store.put(otherKey, "other")
        assertEquals("official", store.get(secretKey))
        assertEquals("other", store.get(otherKey))
        store.remove(otherKey)
        assertEquals("official", store.get(secretKey))
        assertNull(store.get(otherKey))
    }

    @Test
    fun theFileHoldsNeitherTheValueNorTheKey() = runBlocking {
        store().put(secretKey, secret)
        val xml = prefsFile().readText()
        assertFalse("the value is stored in plain text", xml.contains(secret))
        assertFalse("the value is stored in plain text", xml.contains("c2VjcmV0LXZhbHVl"))
        assertFalse("the backend is named in the file", xml.contains("caddie.example.org"))
        assertFalse("the scoped key is named in the file", xml.contains("#device"))
    }

    @Test
    fun aValueMovedToAnotherEntryDoesNotDecrypt() = runBlocking {
        val store = store()
        val prefs = context.getSharedPreferences(file, Context.MODE_PRIVATE)
        store.put(secretKey, secret)
        val (officialEntry, officialValue) = prefs.all.entries.single().let { it.key to it.value as String }
        store.put(otherKey, "other")
        val otherEntry = prefs.all.keys.single { it != officialEntry }
        // Copy the official backend's ciphertext over the other backend's entry, as someone with
        // write access to the file could: the scoped key is the associated data, so it fails.
        prefs.edit().putString(otherEntry, officialValue).commit()
        val fresh = store()
        assertNull(fresh.get(otherKey))
        assertEquals(secret, fresh.get(secretKey))
    }

    @Test
    fun aTamperedValueReadsAsMissingAndIsRemoved() = runBlocking {
        store().put(secretKey, secret)
        val prefs = context.getSharedPreferences(file, Context.MODE_PRIVATE)
        val (name, stored) = prefs.all.entries.single().let { it.key to it.value as String }
        val flipped = stored.toCharArray().also { it[it.size / 2] = if (it[it.size / 2] == 'A') 'B' else 'A' }
        prefs.edit().putString(name, String(flipped)).commit()
        assertNull(store().get(secretKey))
        assertFalse(context.getSharedPreferences(file, Context.MODE_PRIVATE).contains(name))
    }

    @Test
    fun aLostKeystoreKeyReadsAsMissingAndANewValueWorks() = runBlocking {
        store().put(secretKey, secret)
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(alias)
        assertNull(store().get(secretKey))
        store().put(secretKey, "again")
        assertEquals("again", store().get(secretKey))
    }

    @Test
    fun concurrentFirstWritesShareOneKey() = runBlocking {
        val store = store()
        val keys = (1..8).map { SecureStore.scopedKey(official, "name$it") }
        keys.map { k -> async(Dispatchers.IO) { store.put(k, "value of $k") } }.awaitAll()
        for (k in keys) assertEquals("value of $k", store().get(k))
    }
}
