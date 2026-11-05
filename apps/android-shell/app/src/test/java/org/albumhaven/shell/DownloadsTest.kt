package org.albumhaven.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DownloadsTest {
    @Test
    fun aDisabledOrRefusingDownloadManagerAnswersNullInsteadOfThrowing() {
        assertNull(downloadManagerOrNull<Long> { throw IllegalArgumentException("Unknown URL content://downloads/my_downloads") })
        assertNull(downloadManagerOrNull<Long> { throw IllegalStateException("Failed to get external storage files directory") })
        assertNull(downloadManagerOrNull<Long> { throw SecurityException("Unsupported path") })
        assertEquals(42L, downloadManagerOrNull { 42L })
    }
}
