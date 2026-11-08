#ifndef AH_MP3_H
#define AH_MP3_H

#include <stddef.h>

#include "ah_pcm.h"

/*
 * MP3 decoding exactly as the web player's pinned build (wasm-audio-decoders
 * mpg123-decoder 1.0.3, src/mpg123-decoder/src/mpeg_frame_decoder.c and MPEGDecoder.js):
 * the same mpg123 commit, flags, feed mode and read loop, so the server's sample map
 * trims both clients identically.
 */
typedef struct ah_mp3 ah_mp3;

/* Returns NULL when mpg123 cannot be set up. */
ah_mp3 *ah_mp3_open(void);

/* Feeds bytes and appends every frame they complete to [out]; returns 0, or an mpg123 error code. */
int ah_mp3_decode(ah_mp3 *decoder, const unsigned char *bytes, size_t length, ah_pcm *out);

void ah_mp3_close(ah_mp3 *decoder);

#endif
