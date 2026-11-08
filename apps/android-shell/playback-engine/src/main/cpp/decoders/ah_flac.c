#include "ah_flac.h"

#include <stdlib.h>

#include <FLAC/stream_decoder.h>

struct ah_flac {
    FLAC__StreamDecoder *decoder;
    ah_byte_queue *queue;
    ah_pcm *out;
    float *left;
    float *right;
    size_t scratch_frames;
    int failed;
};

static FLAC__StreamDecoderReadStatus read_bytes(
    const FLAC__StreamDecoder *unused, FLAC__byte buffer[], size_t *length, void *context) {
    (void) unused;
    ah_flac *flac = context;
    long copied = ah_byte_queue_read(flac->queue, buffer, *length);
    *length = copied > 0 ? (size_t) copied : 0;
    if (copied < 0) return FLAC__STREAM_DECODER_READ_STATUS_ABORT;
    return copied == 0 ? FLAC__STREAM_DECODER_READ_STATUS_END_OF_STREAM : FLAC__STREAM_DECODER_READ_STATUS_CONTINUE;
}

static int reserve_scratch(ah_flac *flac, size_t frames) {
    if (frames <= flac->scratch_frames) return 0;
    float *left = realloc(flac->left, frames * sizeof(float));
    if (!left) return -1;
    flac->left = left;
    float *right = realloc(flac->right, frames * sizeof(float));
    if (!right) return -1;
    flac->right = right;
    flac->scratch_frames = frames;
    return 0;
}

static FLAC__StreamDecoderWriteStatus write_frame(
    const FLAC__StreamDecoder *unused, const FLAC__Frame *frame,
    const FLAC__int32 *const buffer[], void *context) {
    (void) unused;
    ah_flac *flac = context;
    unsigned int frames = frame->header.blocksize;
    unsigned int bits = frame->header.bits_per_sample;
    if (bits < 2 || bits > 32 || reserve_scratch(flac, frames)) {
        flac->failed = 1;
        return FLAC__STREAM_DECODER_WRITE_STATUS_ABORT;
    }
    // The web build divides by the largest positive sample (0x7FFF at 16 bits), not 2^(bits-1).
    int divisor = (int) ((1u << (bits - 1)) - 1u);
    const FLAC__int32 *left = buffer[0];
    const FLAC__int32 *right = frame->header.channels > 1 ? buffer[1] : buffer[0];
    for (unsigned int sample = 0; sample < frames; sample++) {
        flac->left[sample] = left[sample] / (float) divisor;
        flac->right[sample] = right[sample] / (float) divisor;
    }
    flac->out->sample_rate = frame->header.sample_rate;
    if (ah_pcm_append_planar(flac->out, flac->left, flac->right, frames)) {
        flac->failed = 1;
        return FLAC__STREAM_DECODER_WRITE_STATUS_ABORT;
    }
    return FLAC__STREAM_DECODER_WRITE_STATUS_CONTINUE;
}

static void report_error(const FLAC__StreamDecoder *unused, FLAC__StreamDecoderErrorStatus status, void *context) {
    // libFLAC resynchronizes on the next frame by itself, as the web build lets it.
    (void) unused;
    (void) status;
    (void) context;
}

ah_flac *ah_flac_open(ah_byte_queue *queue) {
    ah_flac *flac = calloc(1, sizeof(ah_flac));
    if (!flac) return NULL;
    flac->queue = queue;
    flac->decoder = FLAC__stream_decoder_new();
    if (!flac->decoder) goto failed;
    FLAC__stream_decoder_set_md5_checking(flac->decoder, false);
    FLAC__stream_decoder_set_metadata_ignore_all(flac->decoder);
    if (FLAC__stream_decoder_init_stream(flac->decoder, read_bytes, NULL, NULL, NULL, NULL,
            write_frame, NULL, report_error, flac) != FLAC__STREAM_DECODER_INIT_STATUS_OK) goto failed;
    return flac;
failed:
    ah_flac_close(flac);
    return NULL;
}

int ah_flac_process(ah_flac *flac, ah_pcm *out) {
    flac->out = out;
    FLAC__bool advanced = FLAC__stream_decoder_process_single(flac->decoder);
    flac->out = NULL;
    FLAC__StreamDecoderState state = FLAC__stream_decoder_get_state(flac->decoder);
    if (state == FLAC__STREAM_DECODER_END_OF_STREAM) return 0;
    if (!advanced || flac->failed || state == FLAC__STREAM_DECODER_ABORTED) return -1;
    return 1;
}

void ah_flac_close(ah_flac *flac) {
    if (!flac) return;
    if (flac->decoder) FLAC__stream_decoder_delete(flac->decoder);
    free(flac->left);
    free(flac->right);
    free(flac);
}
