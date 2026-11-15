#include "ah_decoder.h"

#include <stdlib.h>

#include "ah_byte_queue.h"
#include "ah_flac.h"
#include "ah_mp3.h"

/* What the web conformance script hands its decoder per call. */
#define MP3_READ_BYTES 65536

struct ah_decoder {
    ah_codec codec;
    ah_byte_queue queue;
    ah_mp3 *mp3;
    ah_flac *flac;
    unsigned char chunk[MP3_READ_BYTES];
};

ah_decoder *ah_decoder_open(ah_codec codec) {
    if (codec != AH_CODEC_MP3 && codec != AH_CODEC_FLAC) return NULL;
    ah_decoder *decoder = calloc(1, sizeof(ah_decoder));
    if (!decoder) return NULL;
    decoder->codec = codec;
    ah_byte_queue_init(&decoder->queue);
    if (codec == AH_CODEC_MP3) decoder->mp3 = ah_mp3_open();
    else decoder->flac = ah_flac_open(&decoder->queue);
    if (!decoder->mp3 && !decoder->flac) {
        ah_decoder_close(decoder);
        return NULL;
    }
    return decoder;
}

int ah_decoder_write(ah_decoder *decoder, const unsigned char *bytes, size_t length) {
    return ah_byte_queue_write(&decoder->queue, bytes, length);
}

size_t ah_decoder_buffered_bytes(ah_decoder *decoder) {
    return ah_byte_queue_size(&decoder->queue);
}

void ah_decoder_end(ah_decoder *decoder) {
    ah_byte_queue_end(&decoder->queue);
}

void ah_decoder_cancel(ah_decoder *decoder) {
    ah_byte_queue_cancel(&decoder->queue);
}

int ah_decoder_process(ah_decoder *decoder, ah_pcm *out) {
    if (decoder->flac) return ah_flac_process(decoder->flac, out);
    long read = ah_byte_queue_read(&decoder->queue, decoder->chunk, sizeof(decoder->chunk));
    if (read <= 0) return (int) read;
    return ah_mp3_decode(decoder->mp3, decoder->chunk, (size_t) read, out) == 0 ? 1 : -1;
}

void ah_decoder_close(ah_decoder *decoder) {
    if (!decoder) return;
    ah_mp3_close(decoder->mp3);
    ah_flac_close(decoder->flac);
    ah_byte_queue_destroy(&decoder->queue);
    free(decoder);
}
