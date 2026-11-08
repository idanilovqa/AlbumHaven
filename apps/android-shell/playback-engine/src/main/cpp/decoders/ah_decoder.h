#ifndef AH_DECODER_H
#define AH_DECODER_H

#include <stddef.h>

#include "ah_pcm.h"

/*
 * One encoded stream's decoder. Bytes are written from any thread; one decode thread calls
 * ah_decoder_process, which waits for bytes and decodes what they complete.
 */
typedef enum { AH_CODEC_MP3 = 1, AH_CODEC_FLAC = 2 } ah_codec;

typedef struct ah_decoder ah_decoder;

/* Returns NULL for an unknown codec or when its library cannot be set up. */
ah_decoder *ah_decoder_open(ah_codec codec);

/* Queues bytes; returns 0, or -1 when memory runs out. */
int ah_decoder_write(ah_decoder *decoder, const unsigned char *bytes, size_t length);

/* No more bytes follow. */
void ah_decoder_end(ah_decoder *decoder);

/* Wakes and stops a waiting ah_decoder_process; callable from any thread. */
void ah_decoder_cancel(ah_decoder *decoder);

/*
 * Waits for bytes and appends what they decode to [out]. Returns 1 after progress (which may
 * decode nothing yet), 0 once every written byte is decoded after ah_decoder_end, and -1 on a
 * decoder error or after a cancel.
 */
int ah_decoder_process(ah_decoder *decoder, ah_pcm *out);

/* Call only once no thread is inside ah_decoder_process. */
void ah_decoder_close(ah_decoder *decoder);

#endif
