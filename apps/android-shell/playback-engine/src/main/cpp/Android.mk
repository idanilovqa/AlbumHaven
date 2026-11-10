# ndk-build ships inside the NDK, so the release container needs nothing beyond it.
LOCAL_PATH := $(call my-dir)
include $(LOCAL_PATH)/decoders.mk

# 16 KB pages, as Android 15+ devices may use.
AH_PAGE_FLAGS := -Wl,-z,max-page-size=16384

# mpg123 is LGPL-2.1, so it stays its own shared library.
include $(CLEAR_VARS)
LOCAL_MODULE := ahmpg123
LOCAL_SRC_FILES := $(AH_MPG123_SOURCES)
LOCAL_C_INCLUDES := $(addprefix $(LOCAL_PATH)/,$(AH_MPG123_INCLUDES))
LOCAL_EXPORT_C_INCLUDES := $(LOCAL_PATH)/third_party/mpg123/src/libmpg123
LOCAL_CFLAGS := $(AH_DECODER_CFLAGS) $(AH_MPG123_DEFINES)
LOCAL_LDLIBS := -lm
LOCAL_LDFLAGS := $(AH_PAGE_FLAGS)
include $(BUILD_SHARED_LIBRARY)

include $(CLEAR_VARS)
LOCAL_MODULE := ahflac
LOCAL_SRC_FILES := $(AH_FLAC_SOURCES)
LOCAL_C_INCLUDES := $(addprefix $(LOCAL_PATH)/,$(AH_FLAC_INCLUDES))
LOCAL_CFLAGS := $(AH_DECODER_CFLAGS) $(AH_FLAC_DEFINES)
include $(BUILD_STATIC_LIBRARY)

include $(CLEAR_VARS)
LOCAL_MODULE := ahdecoders
LOCAL_SRC_FILES := $(AH_CORE_SOURCES) jni/ah_decoders_jni.c
LOCAL_C_INCLUDES := $(addprefix $(LOCAL_PATH)/,$(AH_CORE_INCLUDES))
LOCAL_CFLAGS := $(AH_DECODER_CFLAGS) -DFLAC__NO_DLL
LOCAL_STATIC_LIBRARIES := ahflac
LOCAL_SHARED_LIBRARIES := ahmpg123
LOCAL_LDLIBS := -lm
LOCAL_LDFLAGS := $(AH_PAGE_FLAGS)
include $(BUILD_SHARED_LIBRARY)
