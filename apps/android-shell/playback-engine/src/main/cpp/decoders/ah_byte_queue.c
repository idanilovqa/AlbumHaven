#include "ah_byte_queue.h"

#include <stdlib.h>
#include <string.h>

void ah_byte_queue_init(ah_byte_queue *queue) {
    memset(queue, 0, sizeof(*queue));
    pthread_mutex_init(&queue->lock, NULL);
    pthread_cond_init(&queue->readable, NULL);
}

void ah_byte_queue_destroy(ah_byte_queue *queue) {
    pthread_cond_destroy(&queue->readable);
    pthread_mutex_destroy(&queue->lock);
    free(queue->bytes);
}

int ah_byte_queue_write(ah_byte_queue *queue, const unsigned char *bytes, size_t length) {
    pthread_mutex_lock(&queue->lock);
    int result = 0;
    if (queue->start > 0 && queue->end + length > queue->capacity) {
        memmove(queue->bytes, queue->bytes + queue->start, queue->end - queue->start);
        queue->end -= queue->start;
        queue->start = 0;
    }
    if (queue->end + length > queue->capacity) {
        size_t capacity = queue->capacity ? queue->capacity : 65536;
        while (capacity < queue->end + length) capacity *= 2;
        unsigned char *grown = realloc(queue->bytes, capacity);
        if (grown) {
            queue->bytes = grown;
            queue->capacity = capacity;
        } else {
            result = -1;
        }
    }
    if (result == 0) {
        memcpy(queue->bytes + queue->end, bytes, length);
        queue->end += length;
        pthread_cond_signal(&queue->readable);
    }
    pthread_mutex_unlock(&queue->lock);
    return result;
}

size_t ah_byte_queue_size(ah_byte_queue *queue) {
    pthread_mutex_lock(&queue->lock);
    size_t size = queue->end - queue->start;
    pthread_mutex_unlock(&queue->lock);
    return size;
}

static void raise_flag(ah_byte_queue *queue, int *flag) {
    pthread_mutex_lock(&queue->lock);
    *flag = 1;
    pthread_cond_broadcast(&queue->readable);
    pthread_mutex_unlock(&queue->lock);
}

void ah_byte_queue_end(ah_byte_queue *queue) {
    raise_flag(queue, &queue->ended);
}

void ah_byte_queue_cancel(ah_byte_queue *queue) {
    raise_flag(queue, &queue->cancelled);
}

long ah_byte_queue_read(ah_byte_queue *queue, unsigned char *out, size_t length) {
    pthread_mutex_lock(&queue->lock);
    while (queue->start == queue->end && !queue->ended && !queue->cancelled) {
        pthread_cond_wait(&queue->readable, &queue->lock);
    }
    long copied;
    if (queue->cancelled) {
        copied = -1;
    } else {
        size_t available = queue->end - queue->start;
        copied = (long) (length < available ? length : available);
        memcpy(out, queue->bytes + queue->start, (size_t) copied);
        queue->start += (size_t) copied;
    }
    pthread_mutex_unlock(&queue->lock);
    return copied;
}
