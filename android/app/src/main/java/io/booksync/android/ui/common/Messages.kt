package io.booksync.android.ui.common

import androidx.annotation.StringRes
import io.booksync.android.R

/** User-facing text for the core's error codes (the extension's vocabulary). */
@StringRes
fun messageFor(code: String?): Int = when (code) {
    "invalid_credentials" -> R.string.error_invalid_credentials
    "username_taken" -> R.string.error_username_taken
    "registration_closed" -> R.string.error_registration_closed
    "rate_limited" -> R.string.error_rate_limited
    "insecure_url" -> R.string.error_insecure_url
    "network" -> R.string.error_network
    "weak_password" -> R.string.error_weak_password
    "invalid_username" -> R.string.error_invalid_username
    "invalid_format" -> R.string.error_syncid_format
    "invalid_checksum" -> R.string.error_syncid_typo
    "already_signed_in" -> R.string.error_already_signed_in
    "different_user" -> R.string.error_different_user
    "weak_kdf" -> R.string.error_weak_kdf
    "invalid_url" -> R.string.error_invalid_url
    "root_locked" -> R.string.error_root_locked
    "stale" -> R.string.error_stale
    "invalid_move" -> R.string.error_invalid_move
    "not_signed_in" -> R.string.error_not_signed_in
    "state_unreadable" -> R.string.notice_state_unreadable
    else -> R.string.error_generic
}
