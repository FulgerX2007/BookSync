package io.booksync.android.security

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import io.booksync.core.mobile.KeyWrapper
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Supplies the AES key that wraps the core's data key. */
fun interface KeyProvider {
    fun key(): SecretKey
}

/**
 * Wraps the core's 32-byte data key with AES-256-GCM under a key the
 * Android Keystore keeps (it never leaves secure hardware where available).
 * Output: iv(12) ‖ ciphertext ‖ tag.
 */
class KeystoreKeyWrapper(private val keys: KeyProvider = AndroidKeystoreKeys()) : KeyWrapper {

    override fun wrap(dataKey: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, keys.key()) // the provider picks a fresh IV
        val iv = cipher.iv
        check(iv.size == IV_BYTES) { "unexpected IV length ${iv.size}" }
        return iv + cipher.doFinal(dataKey)
    }

    override fun unwrap(wrapped: ByteArray): ByteArray {
        if (wrapped.size < IV_BYTES + TAG_BYTES) throw GeneralSecurityException("wrapped key is truncated")
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, keys.key(), GCMParameterSpec(TAG_BYTES * 8, wrapped, 0, IV_BYTES))
        return cipher.doFinal(wrapped, IV_BYTES, wrapped.size - IV_BYTES)
    }

    private companion object {
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
        const val TAG_BYTES = 16
    }
}

/** The app's Keystore key, created on first use. */
class AndroidKeystoreKeys(private val alias: String = "booksync-state-key") : KeyProvider {
    override fun key(): SecretKey {
        val ks = KeyStore.getInstance(PROVIDER).apply { load(null) }
        (ks.getKey(alias, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        gen.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return gen.generateKey()
    }

    private companion object {
        const val PROVIDER = "AndroidKeyStore"
    }
}
