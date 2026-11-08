# Host build of the Android decoders for the conformance gate:
#   cmake -S apps/android-shell/playback-engine/src/main/cpp/host -B <build> && cmake --build <build>
cmake_minimum_required(VERSION 3.22)
project(album_haven_decode_tool C)
set(CMAKE_C_STANDARD 11)

include(${CMAKE_CURRENT_LIST_DIR}/../decoders.cmake)
find_package(Threads REQUIRED)

add_executable(ah-decode-tool ${CMAKE_CURRENT_LIST_DIR}/ah_decode_tool.c)
target_compile_options(ah-decode-tool PRIVATE ${AH_DECODER_FLAGS})
target_link_libraries(ah-decode-tool PRIVATE ahdecodercore Threads::Threads)
set_target_properties(ah-decode-tool PROPERTIES BUILD_RPATH "$ORIGIN")
