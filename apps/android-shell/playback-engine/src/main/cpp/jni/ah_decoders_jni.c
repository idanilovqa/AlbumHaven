#include <jni.h>
#include <stdint.h>
#include <stdlib.h>

#include "ah_decoder.h"

/* A decoder with the audio its last process call decoded. */
typedef struct {
    ah_decoder *decoder;
    ah_pcm pcm;
} jni_decoder;

static jni_decoder *from_handle(jlong handle) {
    return (jni_decoder *) (intptr_t) handle;
}

JNIEXPORT jint JNI_OnLoad(JavaVM *vm, void *reserved) {
    (void) vm;
    (void) reserved;
    // mpg123 fills its shared tables on first use without a lock; fill them before any decode thread.
    ah_decoder_close(ah_decoder_open(AH_CODEC_MP3));
    return JNI_VERSION_1_6;
}

JNIEXPORT jlong JNICALL
Java_org_albumhaven_playback_decode_StreamDecoder_nativeOpen(JNIEnv *env, jclass type, jint codec) {
    (void) env;
    (void) type;
    jni_decoder *wrapper = calloc(1, sizeof(jni_decoder));
    if (!wrapper) return 0;
    ah_pcm_init(&wrapper->pcm);
    wrapper->decoder = ah_decoder_open((ah_codec) codec);
    if (!wrapper->decoder) {
        free(wrapper);
        return 0;
    }
    return (jlong) (intptr_t) wrapper;
}

JNIEXPORT jboolean JNICALL
Java_org_albumhaven_playback_decode_StreamDecoder_nativeWrite(
    JNIEnv *env, jclass type, jlong handle, jbyteArray bytes, jint offset, jint length) {
    (void) type;
    // A copy, not a pinned array: the write takes the queue lock, which a critical region must not wait on.
    jbyte *data = malloc((size_t) length);
    if (!data) return JNI_FALSE;
    (*env)->GetByteArrayRegion(env, bytes, offset, length, data);
    int result = ah_decoder_write(from_handle(handle)->decoder, (const unsigned char *) data, (size_t) length);
    free(data);
    return result == 0 ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jint JNICALL
Java_org_albumhaven_playback_decode_StreamDecoder_nativeBufferedBytes(JNIEnv *env, jclass type, jlong handle) {
    (void) env;
    (void) type;
    size_t size = ah_decoder_buffered_bytes(from_handle(handle)->decoder);
    return size > 0x7FFFFFFF ? 0x7FFFFFFF : (jint) size;
}

JNIEXPORT void JNICALL
Java_org_albumhaven_playback_decode_StreamDecoder_nativeEnd(JNIEnv *env, jclass type, jlong handle) {
    (void) env;
    (void) type;
    ah_decoder_end(from_handle(handle)->decoder);
}

JNIEXPORT void JNICALL
Java_org_albumhaven_playback_decode_StreamDecoder_nativeCancel(JNIEnv *env, jclass type, jlong handle) {
    (void) env;
    (void) type;
    ah_decoder_cancel(from_handle(handle)->decoder);
}

JNIEXPORT jint JNICALL
Java_org_albumhaven_playback_decode_StreamDecoder_nativeProcess(JNIEnv *env, jclass type, jlong handle) {
    (void) env;
    (void) type;
    jni_decoder *wrapper = from_handle(handle);
    ah_pcm_clear(&wrapper->pcm);
    return ah_decoder_process(wrapper->decoder, &wrapper->pcm);
}

JNIEXPORT jfloatArray JNICALL
Java_org_albumhaven_playback_decode_StreamDecoder_nativeSamples(JNIEnv *env, jclass type, jlong handle) {
    (void) type;
    jni_decoder *wrapper = from_handle(handle);
    jsize count = (jsize) (wrapper->pcm.frames * 2);
    jfloatArray samples = (*env)->NewFloatArray(env, count);
    if (samples && count) (*env)->SetFloatArrayRegion(env, samples, 0, count, wrapper->pcm.samples);
    return samples;
}

JNIEXPORT jint JNICALL
Java_org_albumhaven_playback_decode_StreamDecoder_nativeSampleRate(JNIEnv *env, jclass type, jlong handle) {
    (void) env;
    (void) type;
    return (jint) from_handle(handle)->pcm.sample_rate;
}

JNIEXPORT void JNICALL
Java_org_albumhaven_playback_decode_StreamDecoder_nativeClose(JNIEnv *env, jclass type, jlong handle) {
    (void) env;
    (void) type;
    jni_decoder *wrapper = from_handle(handle);
    ah_decoder_close(wrapper->decoder);
    ah_pcm_free(&wrapper->pcm);
    free(wrapper);
}
