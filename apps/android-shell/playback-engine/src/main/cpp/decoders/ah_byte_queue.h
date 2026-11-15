#ifndef AH_BYTE_QUEUE_H
#define AH_BYTE_QUEUE_H

#include <pthread.h>
#include <stddef.h>

/* Encoded bytes on their way to a decoder: written from any thread, read by one decode thread. */
typedef struct {
    pthread_mutex_t lock;
    pthread_cond_t readable;
    unsigned char *bytes;
    size_t start;
    size_t end;
    size_t capacity;
    int ended;
    int cancelled;
} ah_byte_queue;

void ah_byte_queue_init(ah_byte_queue *queue);
void ah_byte_queue_destroy(ah_byte_queue *queue);

/* Returns 0, or -1 when memory runs out. */
int ah_byte_queue_write(ah_byte_queue *queue, const unsigned char *bytes, size_t length);
/* Bytes written and not read yet. */
size_t ah_byte_queue_size(ah_byte_queue *queue);
void ah_byte_queue_end(ah_byte_queue *queue);
void ah_byte_queue_cancel(ah_byte_queue *queue);

/*
 * Waits for bytes, then copies at most [length] of them into [out]. Returns the bytes copied,
 * 0 once the queue has ended and is empty, and -1 after a cancel.
 */
long ah_byte_queue_read(ah_byte_queue *queue, unsigned char *out, size_t length);

#endif
