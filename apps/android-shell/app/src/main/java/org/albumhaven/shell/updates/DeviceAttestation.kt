package org.albumhaven.shell.updates

import android.content.Context
import android.content.pm.PackageManager
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import androidx.core.content.edit
import java.security.GeneralSecurityException
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.ProviderException
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * Artifact signing keys in Android Keystore: EC P-256, sign-only, never exportable. StrongBox is
 * used when the device has it, otherwise the TEE; the server decides whether a software-only key
 * (an emulator) is acceptable.
 */
class KeystoreDeviceKeys(context: Context) : DeviceKeys {
    private val strongBox = context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)

    override fun create(alias: String, challenge: ByteArray): List<ByteArray>? = try {
        val store = keyStore()
        store.deleteEntry(alias)
        try {
            generate(alias, challenge, strongBox)
        } catch (_: StrongBoxUnavailableException) {
            generate(alias, challenge, strongBox = false)
        }
        val chain = store.getCertificateChain(alias)?.map { it.encoded }
        // A key without an attestation chain proves nothing to the server.
        if (chain == null || chain.size < 2) {
            store.deleteEntry(alias)
            null
        } else {
            chain
        }
    } catch (_: GeneralSecurityException) {
        null
    } catch (_: ProviderException) {
        null
    }

    private fun generate(alias: String, challenge: ByteArray, strongBox: Boolean) {
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setAttestationChallenge(challenge)
            .setIsStrongBoxBacked(strongBox)
            .build()
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE).apply {
            initialize(spec)
            generateKeyPair()
        }
    }

    override fun sign(alias: String, data: ByteArray): ByteArray? = try {
        val entry = keyStore().getEntry(alias, null) as? KeyStore.PrivateKeyEntry
        entry?.let {
            Signature.getInstance("SHA256withECDSA").run {
                initSign(it.privateKey)
                update(data)
                sign()
            }
        }
    } catch (_: GeneralSecurityException) {
        // Includes KeyPermanentlyInvalidatedException.
        null
    } catch (_: ProviderException) {
        null
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
    }
}

/** Non-secret: the server's id for each origin's key. A restored copy without the key is re-attested. */
class PreferencesDeviceKeyIds(context: Context) : DeviceKeyIds {
    private val preferences = context.getSharedPreferences("artifact_device_keys", Context.MODE_PRIVATE)

    override fun get(origin: String): String? = preferences.getString(origin, null)

    override fun set(origin: String, id: String?) =
        preferences.edit { if (id == null) remove(origin) else putString(origin, id) }
}
