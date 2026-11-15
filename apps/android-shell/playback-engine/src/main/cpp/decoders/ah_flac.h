#ifndef AH_FLAC_H
#define AH_FLAC_H

#include "ah_byte_queue.h"
#include "ah_pcm.h"

/*
 * FLAC decoding with the libFLAC commit and sample scaling of the web player's pinned build
 * (wasm-audio-decoders @wasm-audio-decoders/flac 0.2.11, src/flac/src/flac_decoder.c).
 * libFLAC reads from [queue] on the decode thread, waiting for bytes, so it always reads whole
 * frames, as the web build does after codec-parser splits them.
 */
typedef struct ah_flac ah_flac;

/* Returns NULL when libFLAC cannot be set up. */
ah_flac *ah_flac_open(ah_byte_queue *queue);

/* Decodes the next frame into [out]: 1 after progress, 0 at the end, -1 on error or cancel. */
int ah_flac_process(ah_flac *decoder, ah_pcm *out);

void ah_flac_close(ah_flac *decoder);

#endif
