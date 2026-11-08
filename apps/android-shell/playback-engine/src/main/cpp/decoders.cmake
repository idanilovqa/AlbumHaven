# The decoder libraries both the Android build and the host conformance tool compile.
# Sources and defines match the web player's pinned wasm builds (wasm-audio-decoders Makefile,
# targets $(MPG123_WASM_LIB) and $(FLAC_WASM_LIB)); see third_party/*/PINNED.
set(AH_CPP ${CMAKE_CURRENT_LIST_DIR})
set(MPG123_DIR ${AH_CPP}/third_party/mpg123)
set(FLAC_DIR ${AH_CPP}/third_party/flac)

# WebAssembly has no fused multiply-add, so contraction stays off to keep float decoding identical.
set(AH_DECODER_FLAGS -O2 -ffp-contract=off -fno-fast-math -Wno-macro-redefined -Wno-unused-parameter)

# mpg123 is LGPL-2.1, so it stays its own shared library.
add_library(ahmpg123 SHARED
    ${MPG123_DIR}/src/libmpg123/parse.c
    ${MPG123_DIR}/src/libmpg123/frame.c
    ${MPG123_DIR}/src/libmpg123/format.c
    ${MPG123_DIR}/src/libmpg123/dct64.c
    ${MPG123_DIR}/src/libmpg123/id3.c
    ${MPG123_DIR}/src/libmpg123/optimize.c
    ${MPG123_DIR}/src/libmpg123/readers.c
    ${MPG123_DIR}/src/libmpg123/tabinit.c
    ${MPG123_DIR}/src/libmpg123/libmpg123.c
    ${MPG123_DIR}/src/libmpg123/layer1.c
    ${MPG123_DIR}/src/libmpg123/layer2.c
    ${MPG123_DIR}/src/libmpg123/layer3.c
    ${MPG123_DIR}/src/libmpg123/synth_real.c
    # readers.c references the file helpers; feed mode never calls them.
    ${MPG123_DIR}/src/compat/compat.c
    ${MPG123_DIR}/src/compat/compat_str.c)
target_compile_definitions(ahmpg123 PRIVATE OPT_GENERIC REAL_IS_FLOAT)
target_compile_options(ahmpg123 PRIVATE ${AH_DECODER_FLAGS})
target_include_directories(ahmpg123
    PRIVATE ${MPG123_DIR}/src ${MPG123_DIR}/src/compat
    PUBLIC ${MPG123_DIR}/src/libmpg123)
target_link_libraries(ahmpg123 PRIVATE m)

add_library(ahflac STATIC
    ${FLAC_DIR}/src/libFLAC/stream_decoder.c
    ${FLAC_DIR}/src/libFLAC/format.c
    ${FLAC_DIR}/src/libFLAC/crc.c
    ${FLAC_DIR}/src/libFLAC/bitreader.c
    ${FLAC_DIR}/src/libFLAC/bitmath.c
    ${FLAC_DIR}/src/libFLAC/fixed.c
    ${FLAC_DIR}/src/libFLAC/lpc.c
    ${FLAC_DIR}/src/libFLAC/memory.c
    ${FLAC_DIR}/src/libFLAC/md5.c
    ${FLAC_DIR}/src/libFLAC/cpu.c)
set_target_properties(ahflac PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_compile_definitions(ahflac PRIVATE HAVE_CONFIG_H=1 PUBLIC FLAC__NO_DLL)
target_compile_options(ahflac PRIVATE ${AH_DECODER_FLAGS})
target_include_directories(ahflac
    PRIVATE ${FLAC_DIR} ${FLAC_DIR}/src/libFLAC/include
    PUBLIC ${FLAC_DIR}/include)
target_link_libraries(ahflac PUBLIC m)

add_library(ahdecodercore STATIC
    ${AH_CPP}/decoders/ah_byte_queue.c
    ${AH_CPP}/decoders/ah_decoder.c
    ${AH_CPP}/decoders/ah_flac.c
    ${AH_CPP}/decoders/ah_mp3.c
    ${AH_CPP}/decoders/ah_pcm.c)
set_target_properties(ahdecodercore PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_compile_options(ahdecodercore PRIVATE ${AH_DECODER_FLAGS})
target_include_directories(ahdecodercore PUBLIC ${AH_CPP}/decoders)
target_link_libraries(ahdecodercore PUBLIC ahmpg123 ahflac)
