package org.albumhaven.shell.playback

/** Callbacks of one `/playback/pcm` socket; they arrive on a transport thread. */
interface PcmTransportListener {
    fun onOpen()
    fun onText(text: String)
    fun onBinary(bytes: ByteArray)

    /** The socket is gone; [code] is the WebSocket close code, or [ABNORMAL_CLOSURE] on a failure. */
    fun onClosed(code: Int)

    companion object {
        const val ABNORMAL_CLOSURE = 1006
    }
}

/** One authenticated `/playback/pcm` connection. */
interface PcmTransport {
    /** Returns false when the socket cannot take the message now. */
    fun send(text: String): Boolean
    fun close()
}

fun interface PcmTransportFactory {
    /** Starts connecting; [listener] hears [PcmTransportListener.onOpen] or [PcmTransportListener.onClosed]. */
    fun connect(listener: PcmTransportListener): PcmTransport
}

/** Close codes of music_app/routes/playback_stream_asgi.py the native owner reacts to. */
object PcmCloseCodes {
    const val UNAUTHENTICATED = 4401
    const val FORBIDDEN = 4403
    const val MEDIA_NOT_FOUND = 4404
}
