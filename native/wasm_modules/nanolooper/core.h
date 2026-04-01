#ifndef LOOPER_CORE_H
#define LOOPER_CORE_H

#define MAX_EVENTS 256
#define MAX_UNDO 16
#define NUM_CHANNELS 4
#define NUM_STEPS 16

typedef struct {
  double time;    /* position in loop [0, loop_length) */
  int channel;    /* 0-3 */
} Event;

typedef struct {
  Event events[MAX_EVENTS];
  int count;
} EventSnapshot;

typedef struct {
  double loop_length;
  double quantize_step;  /* 0 = no quantize */

  Event events[MAX_EVENTS];
  int event_count;

  EventSnapshot undo_stack[MAX_UNDO];
  int undo_count;
  EventSnapshot redo_stack[MAX_UNDO];
  int redo_count;

  int destructive_recording;
  EventSnapshot pre_record_snapshot;
} LooperCore;

void looper_init(LooperCore* c, double loop_length);
int  looper_trigger(LooperCore* c, int channel, double current_time);
void looper_advance(const LooperCore* c, double prev_time, double new_time,
                    int* fired, int* fired_count);
void looper_clear_channel(LooperCore* c, int channel);
void looper_clear_all(LooperCore* c);
void looper_clear_at(LooperCore* c, int channel, int step);
void looper_begin_destructive_record(LooperCore* c);
void looper_end_destructive_record(LooperCore* c);
void looper_undo(LooperCore* c);
void looper_redo(LooperCore* c);
int  looper_has_event(const LooperCore* c, int channel, int step);

#endif
