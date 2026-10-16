package io.booksync.android.security

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test
import java.security.GeneralSecurityException
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

class KeystoreKeyWrapperTest {
    private fun jvmKey(): SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

    @Test
    fun roundTrip() {
        val key = jvmKey()
        val w = KeystoreKeyWrapper { key }
        val dataKey = ByteArray(32) { it.toByte() }
        val wrapped = w.wrap(dataKey)
        assertArrayEquals(dataKey, w.unwrap(wrapped))
        assertFalse("fresh IV per wrap", w.wrap(dataKey).contentEquals(wrapped))
    }

    @Test
    fun tamperedOrForeignKeyFails() {
        val key = jvmKey()
        val wrapped = KeystoreKeyWrapper { key }.wrap(ByteArray(32))
        val tampered = wrapped.copyOf().also { it[it.size - 1] = (it.last() + 1).toByte() }
        assertThrows(GeneralSecurityException::class.java) { KeystoreKeyWrapper { key }.unwrap(tampered) }
        val other = jvmKey()
        assertThrows(GeneralSecurityException::class.java) { KeystoreKeyWrapper { other }.unwrap(wrapped) }
        assertThrows(GeneralSecurityException::class.java) { KeystoreKeyWrapper { key }.unwrap(ByteArray(10)) }
    }
}
