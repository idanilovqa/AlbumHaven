# Host build of the Android decoders for the conformance gate
# (tests/py/test_playback_decoder_conformance.py):
#   make -C apps/android-shell/playback-engine/src/main/cpp/host BUILD=<directory>
CPP := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/..)
include $(CPP)/decoders.mk

BUILD ?= build
CC ?= cc
TOOL := $(BUILD)/ah-decode-tool
SOURCES := $(AH_MPG123_SOURCES) $(AH_FLAC_SOURCES) $(AH_CORE_SOURCES)
OBJECTS := $(addprefix $(BUILD)/,$(SOURCES:.c=.o))

# The host compiler may be GCC, which knows no -Wno-macro-redefined.
CFLAGS := $(filter-out -Wno-macro-redefined,$(AH_DECODER_CFLAGS)) -Wno-unknown-warning-option
# Each library sees only its own headers: both have a config.h.
include_flags = $(addprefix -I$(CPP)/,$(1))

$(TOOL): $(OBJECTS) $(BUILD)/host/ah_decode_tool.o
	$(CC) -o $@ $^ -lm -lpthread

$(BUILD)/third_party/mpg123/%.o: $(CPP)/third_party/mpg123/%.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) $(AH_MPG123_DEFINES) $(call include_flags,$(AH_MPG123_INCLUDES)) -c $< -o $@

$(BUILD)/third_party/flac/%.o: $(CPP)/third_party/flac/%.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) $(AH_FLAC_DEFINES) $(call include_flags,$(AH_FLAC_INCLUDES)) -c $< -o $@

$(BUILD)/%.o: $(CPP)/%.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -DFLAC__NO_DLL $(call include_flags,$(AH_CORE_INCLUDES)) -c $< -o $@
