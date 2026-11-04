package org.albumhaven.shell

import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.CommandButton
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionCommands
import androidx.media3.session.SessionError
import androidx.media3.session.SessionResult
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

/**
 * The media session's own buttons beside play, previous and next, and the custom commands they
 * send. There are none yet; Android 13+ draws the media card and its colours itself, so these
 * buttons are the only layout an app adds.
 *
 * A future Love toggle is one entry in each place:
 * 1. [commands]: `SessionCommand("org.albumhaven.session.LOVE", Bundle.EMPTY)`.
 * 2. [buttons]: a `CommandButton.Builder(if (loved) ICON_HEART_FILLED else ICON_HEART_UNFILLED)`
 *    with that command and `SLOT_FORWARD_SECONDARY`, chosen from the current item's loved state.
 * 3. [handle]: a `LOVE` branch that sends the love write for the current item and answers
 *    `SessionResult.RESULT_SUCCESS`.
 * The service already grants [commands] to every accepted controller, routes custom commands to
 * [handle] and publishes [buttons] on connect; a loved-state change then calls
 * `MediaSession.setMediaButtonPreferences(buttons(...))`.
 */
@OptIn(UnstableApi::class)
object SessionControls {
    val commands: List<SessionCommand> = emptyList()

    fun buttons(): List<CommandButton> = emptyList()

    fun sessionCommands(): SessionCommands =
        MediaSession.ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS.buildUpon().apply { commands.forEach(::add) }.build()

    /** Answers one of [commands]; nothing is supported yet. */
    fun handle(command: SessionCommand): ListenableFuture<SessionResult> =
        Futures.immediateFuture(SessionResult(SessionError.ERROR_NOT_SUPPORTED))
}
