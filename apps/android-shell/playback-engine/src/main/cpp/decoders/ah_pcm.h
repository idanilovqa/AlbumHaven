#ifndef AH_PCM_H
#define AH_PCM_H

#include <stddef.h>

/*
 * Decoded audio as interleaved stereo float frames. Channels map as the web player's
 * appendStreamingDecodedAudio does: the first two channels play, and mono plays on both.
 */
typedef struct {
    float *samples;
    size_t frames;
    size_t capacity_frames;
    unsigned int sample_rate;
} ah_pcm;

void ah_pcm_init(ah_pcm *pcm);
void ah_pcm_free(ah_pcm *pcm);
void ah_pcm_clear(ah_pcm *pcm);

/* Appends frames from planar channel pointers; returns 0, or -1 when memory runs out. */
int ah_pcm_append_planar(ah_pcm *pcm, const float *left, const float *right, size_t frames);

/* Appends interleaved stereo frames; returns 0, or -1 when memory runs out. */
int ah_pcm_append_interleaved(ah_pcm *pcm, const float *stereo, size_t frames);

#endif
