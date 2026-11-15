# The decoder sources and flags both the APK (Android.mk) and the conformance gate's host tool
# (host/Makefile) build. They match the web player's pinned wasm builds (wasm-audio-decoders
# Makefile, targets $(MPG123_WASM_LIB) and $(FLAC_WASM_LIB)); see third_party/*/PINNED.
# Paths are relative to this directory.

AH_MPG123_SOURCES := \
    third_party/mpg123/src/libmpg123/parse.c \
    third_party/mpg123/src/libmpg123/frame.c \
    third_party/mpg123/src/libmpg123/format.c \
    third_party/mpg123/src/libmpg123/dct64.c \
    third_party/mpg123/src/libmpg123/id3.c \
    third_party/mpg123/src/libmpg123/optimize.c \
    third_party/mpg123/src/libmpg123/readers.c \
    third_party/mpg123/src/libmpg123/tabinit.c \
    third_party/mpg123/src/libmpg123/libmpg123.c \
    third_party/mpg123/src/libmpg123/layer1.c \
    third_party/mpg123/src/libmpg123/layer2.c \
    third_party/mpg123/src/libmpg123/layer3.c \
    third_party/mpg123/src/libmpg123/synth_real.c \
    third_party/mpg123/src/compat/compat.c \
    third_party/mpg123/src/compat/compat_str.c
# readers.c references compat's file helpers; feed mode never calls them.
AH_MPG123_INCLUDES := third_party/mpg123/src third_party/mpg123/src/compat third_party/mpg123/src/libmpg123
AH_MPG123_DEFINES := -DOPT_GENERIC -DREAL_IS_FLOAT

AH_FLAC_SOURCES := \
    third_party/flac/src/libFLAC/stream_decoder.c \
    third_party/flac/src/libFLAC/format.c \
    third_party/flac/src/libFLAC/crc.c \
    third_party/flac/src/libFLAC/bitreader.c \
    third_party/flac/src/libFLAC/bitmath.c \
    third_party/flac/src/libFLAC/fixed.c \
    third_party/flac/src/libFLAC/lpc.c \
    third_party/flac/src/libFLAC/memory.c \
    third_party/flac/src/libFLAC/md5.c \
    third_party/flac/src/libFLAC/cpu.c
AH_FLAC_INCLUDES := third_party/flac third_party/flac/src/libFLAC/include third_party/flac/include
AH_FLAC_DEFINES := -DHAVE_CONFIG_H=1 -DFLAC__NO_DLL

AH_CORE_SOURCES := \
    decoders/ah_byte_queue.c \
    decoders/ah_decoder.c \
    decoders/ah_flac.c \
    decoders/ah_mp3.c \
    decoders/ah_pcm.c
AH_CORE_INCLUDES := decoders third_party/mpg123/src/libmpg123 third_party/flac/include

# WebAssembly has no fused multiply-add, so contraction stays off to keep float decoding identical.
AH_DECODER_CFLAGS := -std=gnu11 -O2 -ffp-contract=off -fno-fast-math -Wno-macro-redefined -Wno-unused-parameter
