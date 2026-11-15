#include "ah_mp3.h"

#include <stdlib.h>

#include <mpg123.h>

/* MPEG_PCM_OUT_SIZE of the web wrapper: the largest frame times the bit reservoir, in stereo samples. */
#define PCM_OUT_SAMPLES (2889 * 16 * 2)

/* MPEGDecoder.js feeds at most its input buffer per mpg123_feed call. */
#define FEED_CHUNK_BYTES (2889 * 16)

struct ah_mp3 {
    mpg123_handle *handle;
    float pcm[PCM_OUT_SAMPLES];
};

ah_mp3 *ah_mp3_open(void) {
    ah_mp3 *decoder = malloc(sizeof(ah_mp3));
    if (!decoder) return NULL;
    int error = 0;
    decoder->handle = mpg123_new(NULL, &error);
    if (!decoder->handle || error) goto failed;
    if (mpg123_param(decoder->handle, MPG123_FLAGS,
            MPG123_SKIP_ID3V2 | MPG123_PLAIN_ID3TEXT | MPG123_NO_PEEK_END |
            MPG123_NO_READAHEAD | MPG123_FORCE_STEREO | MPG123_QUIET, 0) != MPG123_OK) goto failed;
    if (mpg123_param(decoder->handle, MPG123_ADD_FLAGS, MPG123_GAPLESS, 0) != MPG123_OK) goto failed;
    if (mpg123_open_feed(decoder->handle) != MPG123_OK) goto failed;
    return decoder;
failed:
    ah_mp3_close(decoder);
    return NULL;
}

int ah_mp3_decode(ah_mp3 *decoder, const unsigned char *bytes, size_t length, ah_pcm *out) {
    for (size_t offset = 0; offset < length;) {
        size_t chunk = length - offset < FEED_CHUNK_BYTES ? length - offset : FEED_CHUNK_BYTES;
        int error = mpg123_feed(decoder->handle, bytes + offset, chunk);
        offset += chunk;
        if (error == MPG123_NEED_MORE) continue;
        if (error != MPG123_OK) return error;
        for (;;) {
            size_t bytes_decoded = 0;
            error = mpg123_read(decoder->handle, (unsigned char *) decoder->pcm, sizeof(decoder->pcm), &bytes_decoded);
            size_t frames = bytes_decoded / sizeof(float) / 2;
            if (frames && ah_pcm_append_interleaved(out, decoder->pcm, frames)) return MPG123_OUT_OF_MEM;
            if (frames) {
                long rate = 0;
                mpg123_getformat(decoder->handle, &rate, NULL, NULL);
                out->sample_rate = (unsigned int) rate;
            }
            if (error == MPG123_NEW_FORMAT) continue;
            if (error == MPG123_NEED_MORE) break;
            // The web build logs other errors and keeps reading; a decoder that stops making
            // progress here would never end, so the error is returned instead.
            if (error != MPG123_OK) return error;
        }
    }
    return MPG123_OK;
}

void ah_mp3_close(ah_mp3 *decoder) {
    if (!decoder) return;
    if (decoder->handle) mpg123_delete(decoder->handle);
    free(decoder);
}
