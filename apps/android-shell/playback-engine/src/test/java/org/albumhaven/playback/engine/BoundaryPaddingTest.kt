package org.albumhaven.playback.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The bounds at 48 kHz: 3 072 edge frames (64 ms) and a 480-frame (10 ms) content window. */
class BoundaryPaddingTest {
    private fun stereo(vararg runs: Pair<Int, Float>): FloatArray =
        runs.flatMap { (frames, level) -> List(frames * PcmRing.CHANNELS) { level } }.toFloatArray()

    private fun classify(samples: FloatArray, edge: BoundaryEdge) = BoundaryPadding.classify(samples, RATE, edge)

    @Test
    fun zeroPaddingBeforeContentIsRemovable() {
        val decision = classify(stereo(1_105 to 0f, 2_447 to 0.25f), BoundaryEdge.PREFIX)
        assertTrue(decision.confident)
        assertEquals(1_105, decision.removableFrames)
    }

    @Test
    fun lowCodecNoiseAfterContentIsRemovable() {
        val decision = classify(stereo(2_000 to 0.25f, 1_552 to 0.003f), BoundaryEdge.SUFFIX)
        assertTrue(decision.confident)
        assertEquals(1_552, decision.removableFrames)
        assertTrue(decision.contentRmsDb - decision.edgeRmsDb >= 20)
    }

    @Test
    fun theLongestRemovableRunIsSixtyFourMilliseconds() {
        assertEquals(3_072, classify(stereo(3_072 to 0f, 480 to 0.25f), BoundaryEdge.PREFIX).removableFrames)
        assertEquals(0, classify(stereo(3_073 to 0f, 479 to 0.25f), BoundaryEdge.PREFIX).removableFrames)
    }

    @Test
    fun intentionalSilenceLongerThanTheBoundIsKept() {
        val decision = classify(stereo(3_552 to 0f), BoundaryEdge.SUFFIX)
        assertFalse(decision.confident)
        assertEquals(0, decision.removableFrames)
    }

    @Test
    fun aFadeIsKeptBecauseItsEdgeIsNotFarBelowTheContent() {
        val fade = FloatArray(3_552 * PcmRing.CHANNELS) { index -> 0.25f * (1 - (index / 2 + 1) / 3_552f) }
        val decision = classify(fade, BoundaryEdge.SUFFIX)
        assertFalse(decision.confident)
        assertEquals(0, decision.removableFrames)
    }

    @Test
    fun aHardCutHasNothingToRemove() {
        assertEquals(0, classify(stereo(3_552 to 0.25f), BoundaryEdge.SUFFIX).removableFrames)
    }

    @Test
    fun quietPaddingNearContentLevelIsKept() {
        assertFalse(classify(stereo(1_000 to 0.009f, 2_552 to 0.012f), BoundaryEdge.PREFIX).confident)
    }

    @Test
    fun nonFiniteSamplesAndBrokenStereoShapesAreRejected() {
        val nonFinite = stereo(1_000 to 0f, 2_552 to 0.25f).also { it[3_000] = Float.NaN }
        assertFalse(classify(nonFinite, BoundaryEdge.PREFIX).confident)
        assertFalse(classify(FloatArray(7), BoundaryEdge.PREFIX).confident)
    }
}
