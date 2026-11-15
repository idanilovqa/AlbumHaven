#include "ah_pcm.h"

#include <stdlib.h>
#include <string.h>

void ah_pcm_init(ah_pcm *pcm) {
    memset(pcm, 0, sizeof(*pcm));
}

void ah_pcm_free(ah_pcm *pcm) {
    free(pcm->samples);
    ah_pcm_init(pcm);
}

void ah_pcm_clear(ah_pcm *pcm) {
    pcm->frames = 0;
}

static int reserve(ah_pcm *pcm, size_t frames) {
    size_t needed = pcm->frames + frames;
    if (needed <= pcm->capacity_frames) return 0;
    size_t capacity = pcm->capacity_frames ? pcm->capacity_frames : 4096;
    while (capacity < needed) capacity *= 2;
    float *grown = realloc(pcm->samples, capacity * 2 * sizeof(float));
    if (!grown) return -1;
    pcm->samples = grown;
    pcm->capacity_frames = capacity;
    return 0;
}

int ah_pcm_append_planar(ah_pcm *pcm, const float *left, const float *right, size_t frames) {
    if (reserve(pcm, frames)) return -1;
    float *out = pcm->samples + pcm->frames * 2;
    for (size_t frame = 0; frame < frames; frame++) {
        out[frame * 2] = left[frame];
        out[frame * 2 + 1] = right[frame];
    }
    pcm->frames += frames;
    return 0;
}

int ah_pcm_append_interleaved(ah_pcm *pcm, const float *stereo, size_t frames) {
    if (reserve(pcm, frames)) return -1;
    memcpy(pcm->samples + pcm->frames * 2, stereo, frames * 2 * sizeof(float));
    pcm->frames += frames;
    return 0;
}
