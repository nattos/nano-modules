#include "core.h"

#include <cmath>

#define EPSILON 1e-6

static double wrap(double time, double len) {
  double t = fmod(time, len);
  if (t < 0) t += len;
  return t;
}

static double quantize(double time, double len, double step) {
  double t = wrap(time, len);
  if (step > 0) {
    t = floor(t / step) * step;
  }
  return t;
}

static void save_snapshot(const LooperCore* c, EventSnapshot* s) {
  s->count = c->event_count;
  for (int i = 0; i < c->event_count; i++)
    s->events[i] = c->events[i];
}

static void load_snapshot(LooperCore* c, const EventSnapshot* s) {
  c->event_count = s->count;
  for (int i = 0; i < s->count; i++)
    c->events[i] = s->events[i];
}

static void push_undo(LooperCore* c) {
  if (c->undo_count < MAX_UNDO) {
    save_snapshot(c, &c->undo_stack[c->undo_count++]);
  } else {
    /* Shift stack down, drop oldest */
    for (int i = 0; i < MAX_UNDO - 1; i++)
      c->undo_stack[i] = c->undo_stack[i + 1];
    save_snapshot(c, &c->undo_stack[MAX_UNDO - 1]);
  }
  c->redo_count = 0;
}

void looper_init(LooperCore* c, double loop_length) {
  c->loop_length = loop_length;
  c->quantize_step = 1.0;
  c->event_count = 0;
  c->undo_count = 0;
  c->redo_count = 0;
  c->destructive_recording = 0;
  c->pre_record_snapshot.count = 0;
}

int looper_trigger(LooperCore* c, int channel, double current_time) {
  double t = quantize(current_time, c->loop_length, c->quantize_step);

  /* Check for duplicate */
  for (int i = 0; i < c->event_count; i++) {
    if (c->events[i].channel == channel && fabs(c->events[i].time - t) < EPSILON)
      return 0;
  }

  if (c->event_count >= MAX_EVENTS) return 0;

  if (!c->destructive_recording)
    push_undo(c);

  c->events[c->event_count].time = t;
  c->events[c->event_count].channel = channel;
  c->event_count++;
  return 1;
}

void looper_advance(const LooperCore* c, double prev_time, double new_time,
                    int* fired, int* fired_count) {
  *fired_count = 0;
  for (int i = 0; i < c->event_count; i++) {
    int in_range;
    if (new_time >= prev_time) {
      in_range = c->events[i].time >= prev_time - EPSILON &&
                 c->events[i].time < new_time - EPSILON;
    } else {
      in_range = (c->events[i].time >= prev_time - EPSILON) ||
                 (c->events[i].time < new_time - EPSILON);
    }
    if (in_range && *fired_count < NUM_CHANNELS) {
      fired[(*fired_count)++] = c->events[i].channel;
    }
  }
}

void looper_clear_channel(LooperCore* c, int channel) {
  int has = 0;
  for (int i = 0; i < c->event_count; i++)
    if (c->events[i].channel == channel) { has = 1; break; }
  if (!has) return;

  push_undo(c);
  int j = 0;
  for (int i = 0; i < c->event_count; i++) {
    if (c->events[i].channel != channel)
      c->events[j++] = c->events[i];
  }
  c->event_count = j;
}

void looper_clear_all(LooperCore* c) {
  if (c->event_count == 0) return;
  push_undo(c);
  c->event_count = 0;
}

void looper_clear_at(LooperCore* c, int channel, int step) {
  int has = 0;
  for (int i = 0; i < c->event_count; i++) {
    if (c->events[i].channel == channel &&
        (int)floor(c->events[i].time) == step) { has = 1; break; }
  }
  if (!has) return;
  if (!c->destructive_recording)
    push_undo(c);
  int j = 0;
  for (int i = 0; i < c->event_count; i++) {
    if (!(c->events[i].channel == channel &&
          (int)floor(c->events[i].time) == step))
      c->events[j++] = c->events[i];
  }
  c->event_count = j;
}

void looper_begin_destructive_record(LooperCore* c) {
  save_snapshot(c, &c->pre_record_snapshot);
  c->destructive_recording = 1;
}

void looper_end_destructive_record(LooperCore* c) {
  if (!c->destructive_recording) return;
  c->destructive_recording = 0;
  if (c->undo_count < MAX_UNDO) {
    c->undo_stack[c->undo_count++] = c->pre_record_snapshot;
  }
  c->redo_count = 0;
}

void looper_undo(LooperCore* c) {
  if (c->undo_count == 0) return;
  if (c->redo_count < MAX_UNDO) {
    save_snapshot(c, &c->redo_stack[c->redo_count++]);
  }
  c->undo_count--;
  load_snapshot(c, &c->undo_stack[c->undo_count]);
}

void looper_redo(LooperCore* c) {
  if (c->redo_count == 0) return;
  if (c->undo_count < MAX_UNDO) {
    save_snapshot(c, &c->undo_stack[c->undo_count++]);
  }
  c->redo_count--;
  load_snapshot(c, &c->redo_stack[c->redo_count]);
}

int looper_has_event(const LooperCore* c, int channel, int step) {
  for (int i = 0; i < c->event_count; i++) {
    if (c->events[i].channel == channel &&
        (int)floor(c->events[i].time) == step)
      return 1;
  }
  return 0;
}
