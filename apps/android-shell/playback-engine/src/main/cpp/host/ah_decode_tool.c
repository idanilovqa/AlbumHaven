/*
 * Decodes the bytes a stream would send with the Android decoders, for the conformance
 * gate (tests/py/test_playback_decoder_conformance.py). Mirrors
 * tests/js/support/decode-encoded-stream.cjs: 64 KiB writes, then the end of input, and the
 * left channel written as float32 little-endian.
 *
 * Usage: ah-decode-tool <mp3|flac> <input> <output>
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../decoders/ah_decoder.h"

#define WRITE_BYTES 65536

static unsigned char *read_file(const char *path, size_t *length) {
    FILE *file = fopen(path, "rb");
    if (!file) return NULL;
    fseek(file, 0, SEEK_END);
    long size = ftell(file);
    fseek(file, 0, SEEK_SET);
    unsigned char *bytes = malloc(size > 0 ? (size_t) size : 1);
    *length = bytes ? fread(bytes, 1, (size_t) size, file) : 0;
    fclose(file);
    return bytes;
}

static int decode(ah_codec codec, const unsigned char *bytes, size_t length, ah_pcm *out) {
    ah_decoder *decoder = ah_decoder_open(codec);
    if (!decoder) return 1;
    for (size_t offset = 0; offset < length; offset += WRITE_BYTES) {
        size_t chunk = length - offset < WRITE_BYTES ? length - offset : WRITE_BYTES;
        if (ah_decoder_write(decoder, bytes + offset, chunk)) return 1;
    }
    ah_decoder_end(decoder);
    int status;
    while ((status = ah_decoder_process(decoder, out)) > 0) {}
    ah_decoder_close(decoder);
    return status < 0;
}

int main(int argc, char **argv) {
    if (argc != 4) {
        fprintf(stderr, "usage: %s <mp3|flac> <input> <output>\n", argv[0]);
        return 2;
    }
    size_t length = 0;
    unsigned char *bytes = read_file(argv[2], &length);
    if (!bytes) return 2;
    ah_pcm pcm;
    ah_pcm_init(&pcm);
    ah_codec codec = strcmp(argv[1], "mp3") == 0 ? AH_CODEC_MP3 : strcmp(argv[1], "flac") == 0 ? AH_CODEC_FLAC : 0;
    int failed = codec ? decode(codec, bytes, length, &pcm) : 2;
    free(bytes);
    if (failed) {
        fprintf(stderr, "decoding failed\n");
        return 1;
    }
    FILE *output = fopen(argv[3], "wb");
    if (!output) return 2;
    for (size_t frame = 0; frame < pcm.frames; frame++) fwrite(&pcm.samples[frame * 2], sizeof(float), 1, output);
    fclose(output);
    printf("{\"frames\": %zu}\n", pcm.frames);
    ah_pcm_free(&pcm);
    return 0;
}
