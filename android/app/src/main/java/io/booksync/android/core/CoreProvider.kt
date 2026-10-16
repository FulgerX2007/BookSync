package io.booksync.android.core

/** Implemented by the Application; lets the share activity and worker reach the single core. */
interface CoreProvider {
    val core: BookSyncCore
}
