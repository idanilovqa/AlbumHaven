cmake_minimum_required(VERSION 3.22)
project(album_haven_playback C)
set(CMAKE_C_STANDARD 11)

include(${CMAKE_CURRENT_LIST_DIR}/decoders.cmake)

add_library(ahdecoders SHARED ${CMAKE_CURRENT_LIST_DIR}/jni/ah_decoders_jni.c)
target_compile_options(ahdecoders PRIVATE ${AH_DECODER_FLAGS})
target_link_libraries(ahdecoders PRIVATE ahdecodercore)
# 16 KB pages, as Android 15+ devices may use.
target_link_options(ahdecoders PRIVATE "-Wl,-z,max-page-size=16384")
target_link_options(ahmpg123 PRIVATE "-Wl,-z,max-page-size=16384")
