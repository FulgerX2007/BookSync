package io.booksync.android.ui.auth

import io.booksync.android.core.CoreException
import io.booksync.android.core.FakeCore
import io.booksync.android.core.Kit
import io.booksync.android.ui.MainDispatcherRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class AuthViewModelTest {
    @get:Rule val main = MainDispatcherRule()

    private val validSyncId = "BS1-" + "A".repeat(28).chunked(4).joinToString("-")

    private fun filled(vm: AuthViewModel, password: String = "long enough pw") {
        vm.setServerUrl(" https://sync.example ")
        vm.setUsername("alice")
        vm.setPassword(password)
    }

    @Test
    fun registerSucceedsAndClearsSecrets() {
        val core = FakeCore()
        val vm = AuthViewModel(core)
        filled(vm)
        assertFalse("no confirmation yet", vm.form.value.canRegister)
        vm.setConfirm("long enough pw")
        assertTrue(vm.form.value.canRegister)
        var kit: Kit? = null
        vm.register { kit = it }
        assertEquals(core.kit, kit)
        assertEquals("register https://sync.example alice", core.calls.single())
        with(vm.form.value) {
            assertEquals("", password)
            assertEquals("", confirm)
            assertFalse(busy)
            assertNull(error)
        }
    }

    @Test
    fun registerValidation() {
        val vm = AuthViewModel(FakeCore())
        filled(vm, password = "short")
        assertTrue(vm.form.value.passwordTooShort)
        assertFalse(vm.form.value.canRegister)
        vm.setPassword("ten chars!")
        vm.setConfirm("ten chars?")
        assertTrue(vm.form.value.confirmMismatch)
        assertFalse(vm.form.value.canRegister)
        // Length counts characters, not UTF-16 units: 9 emoji are 9 characters.
        vm.setPassword("😀".repeat(9))
        assertTrue(vm.form.value.passwordTooShort)
    }

    @Test
    fun errorsSurfaceAsCodes() {
        for (code in listOf("invalid_credentials", "username_taken", "registration_closed", "rate_limited", "network", "insecure_url")) {
            val core = FakeCore()
            val vm = AuthViewModel(core)
            filled(vm)
            vm.setSyncId(validSyncId)
            core.failNext = CoreException(code, "x")
            var done = false
            vm.login { done = true }
            assertFalse(done)
            assertEquals(code, vm.form.value.error)
            assertFalse(vm.form.value.busy)
            assertEquals("long enough pw", vm.form.value.password) // kept for a retry
            vm.setUsername("alice2")
            assertNull("editing clears the error", vm.form.value.error)
        }
    }

    @Test
    fun syncIdIsValidatedOnceComplete() {
        val vm = AuthViewModel(FakeCore())
        filled(vm)
        vm.setSyncId("BS1-AAAA")
        assertNull("incomplete: no error yet", vm.form.value.syncIdError)
        assertFalse(vm.form.value.canLogin)
        vm.setSyncId(validSyncId.dropLast(2) + "ZZ")
        assertEquals("invalid_checksum", vm.form.value.syncIdError)
        assertFalse(vm.form.value.canLogin)
        vm.setSyncId(validSyncId.lowercase())
        assertNull(vm.form.value.syncIdError)
        assertTrue(vm.form.value.canLogin)
    }

    @Test
    fun loginSucceedsAndPrefill() {
        val core = FakeCore()
        val vm = AuthViewModel(core)
        vm.prefill("https://sync.example", "alice")
        vm.setPassword("pw")
        vm.setSyncId(validSyncId)
        var done = false
        vm.login { done = true }
        assertTrue(done)
        assertEquals("login https://sync.example alice $validSyncId", core.calls.single())
        assertEquals("", vm.form.value.syncId)
        vm.prefill("", "")
        assertEquals("prefill keeps typed values", "alice", vm.form.value.username)
    }
}
