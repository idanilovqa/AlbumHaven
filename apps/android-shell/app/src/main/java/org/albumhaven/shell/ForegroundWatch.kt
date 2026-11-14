package org.albumhaven.shell

/** One current resume probe; stale replies and timeouts cannot affect a newer foreground. */
internal class ForegroundWatch {
    private var sequence = 0L
    private var pending = 0L

    fun start(): Long = (++sequence).also { pending = it }

    fun cancel() {
        pending = 0
    }

    fun answered(token: Long): Boolean = take(token)

    fun timedOut(token: Long): Boolean = take(token)

    private fun take(token: Long): Boolean {
        if (token <= 0 || token != pending) return false
        pending = 0
        return true
    }
}
