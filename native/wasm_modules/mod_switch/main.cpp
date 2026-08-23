/*
 * mod.shaper.switch — pick one of N inputs, whatever they carry.
 *
 * ONE card that switches floats, colours OR textures, rather than one node per
 * type. That is the whole point: `mod.switch` / `color.switch` / `video.switch`
 * would be three cards that look identical and do the same thing.
 *
 * It works because the cases are `any` ports (host.h's anyField): a schema is
 * published once per module TYPE, so this card cannot declare what its cases
 * carry — the executor's rail lowering resolves that per INSTANCE by walking
 * back through the wire graph (wire_types.h) and builds an ordinary float / vec
 * / texture / struct rail. Nothing downstream ever sees `any`.
 *
 * ARITY follows mod_math exactly: a fixed bank of 8 cases plus an `input_count`
 * VALUE, because arity can no more be a schema shape than type can. Cases above
 * the count are hidden in the editor (web/src/state/math-nodes.ts's rule) and
 * skipped here.
 *
 * SELECT is deliberately an ordinary float, not an `any` port:
 *   - it is the magnitude-marked PrimaryInput, so the executor's shaper
 *     auto-connect wires it from a preceding modulation source — drop this
 *     after an LFO and the LFO drives the selection, which is the gesture you
 *     want. That also means the node needs no `any`-aware auto-connect at all.
 *   - it is NOT raw. A raw selector would receive an LFO's literal 0..1 and,
 *     since the case index comes from scaling by the live count, that happens
 *     to work — but declaring it raw would break the moment someone wired a
 *     source with a different declared range. The normal fold maps any source
 *     into [0,1] and the count does the rest.
 *
 * The index is `select * count`, floored and clamped, so 0..1 sweeps every case
 * regardless of how many there are. The alternative — declaring select as
 * [0, kMaxCases-1] — would leave an LFO sweeping mostly out of range whenever
 * the count is less than 8.
 *
 * TYPE DISPATCH happens at tick(), by probing what actually arrived: a texture
 * rail binds a handle (textureForField answers), a vec rail patches an array, a
 * float rail patches a number. Those are different channels, so the arriving
 * class is observable without the host telling us. textureForField is a plain
 * state lookup with no render context, which is what makes this legal in tick()
 * — and it must be tick(), because a node whose only output is `any` has no
 * texture output, so hasTextureOutput is false and render() never runs.
 *
 * A texture case is ALIASED, not blitted: we publish the selected input's
 * handle as our own output and captureWriteTaps picks it up. Switching video
 * costs nothing per frame.
 *
 * Pure data module — no GPU work of its own, no texture I/O.
 */

#include <host.h>
#include <gpu.h>
#include <val.h>
#include <cstdio>
#include <cstring>

namespace mod_switch {

/// Schema's fixed case ceiling. `input_count` picks how many participate.
/// Mirrors MATH_MAX_INPUTS in web/src/state/math-nodes.ts.
constexpr int kMaxCases = 8;
/// Widest vec a case can carry (float4).
constexpr int kMaxComps = 4;

// What a case is currently carrying. Discovered per frame from which channel
// delivered — never declared.
enum Arrived { NothingYet = 0, AsFloat, AsVec };

struct Case {
  Arrived kind = NothingYet;
  float   scalar = 0.0f;
  float   comps[kMaxComps] = {0, 0, 0, 0};
  int     nComps = 0;
};

struct State {
  float select = 0.0f;
  int   count = 2;
  Case  cases[kMaxCases];

  void reset() {
    select = 0.0f;
    count = 2;
    for (int i = 0; i < kMaxCases; ++i) cases[i] = Case{};
  }
};

/// The active case index for a given select value and count. Shared by tick()
/// so the rule lives in exactly one place.
static int selectedIndex(float select, int count) {
  const int n = (count < 2) ? 2 : (count > kMaxCases ? kMaxCases : count);
  int idx = static_cast<int>(select * static_cast<float>(n));
  if (idx < 0) idx = 0;
  if (idx >= n) idx = n - 1;    // select == 1.0 lands on the last case
  return idx;
}

void module_init() {
  state::Schema schema;
  schema.helpField("intro",
    "## Switch\n"
    "Picks **one of its inputs** and passes it through. The inputs can be "
    "anything wireable — numbers, colours, or video — and the card takes on "
    "whatever you plug into it.\n\n"
    "*Select* chooses, sweeping across the cases from 0 to 1. Dropped straight "
    "after a modulation source it wires up automatically, so an LFO cycles the "
    "cases and a beat trigger steps them.\n\n"
    "Add or remove cases from the **gear** icon.\n\n"
    "**Try:** three *Colour* nodes into the cases and a beat trigger on "
    "*Select* — a palette that changes on the beat.");

  schema.group("select", "Select")
        .groupHelp(
          "Which case comes out. The range 0..1 spans however many cases you "
          "have, so the same wire keeps working when you add one.");
  // PRIMARY + magnitude-marked: this is what the executor's shaper
  // auto-connect binds from a preceding modulation source.
  schema.floatField("select", 0.0f, 0.f, 1.f, state::PrimaryInput, "unsigned")
        .label("Select", "Sel");

  schema.group("cases", "Cases")
        .groupHelp(
          "The inputs to choose between. Each takes whatever you wire to it — "
          "the first one you connect decides what kind of card this is. Use the "
          "gear icon to change how many cases there are.");
  for (int i = 0; i < kMaxCases; ++i) {
    char name[16], disp[16], shortl[8];
    std::snprintf(name, sizeof(name), "case_%d", i + 1);
    std::snprintf(disp, sizeof(disp), "Case %d", i + 1);
    std::snprintf(shortl, sizeof(shortl), "%d", i + 1);
    // SecondaryInput: never auto-picked (that is select's job), wired by hand.
    // Declaration order matters — case_1 is the type tie-break winner.
    schema.anyField(name, state::SecondaryInput).label(disp, shortl);
  }

  // Card SHAPE rather than a value, so the editor puts it under the gear icon.
  schema.intField("input_count", 2, 2, kMaxCases, state::SecondaryInput)
        .label("Cases", "N");

  schema.group("output", "Output");
  schema.anyField("output", state::PrimaryOutput).label("Output", "Out");

  schema.capability(state::Capability::ModulationShaper)
        // "more than one modulation input" — what the arity-aware UI reads.
        .capability(state::Capability::ModulationShaperBinary)
        .capability(state::Capability::TimeIndependent);

  state::init("mod.shaper.switch", {1, 0, 0}, schema);
}

void* create() { return new State(); }

void destroy(void* self) { delete static_cast<State*>(self); }

void init(void* self) {
  auto* s = static_cast<State*>(self);
  if (s) s->reset();
}

void tick(void* self, double dt) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  (void)dt;
  // Read taps landed before doTick, so every case's channel is populated.
  const int idx = selectedIndex(s->select, s->count);

  char field[16];
  std::snprintf(field, sizeof(field), "case_%d", idx + 1);

  // Texture first: a bound handle is unambiguous, and a texture case never also
  // patches a number. Aliased through — no blit.
  auto tex = gpu::Device::textureForField(field);
  if (tex.valid()) {
    state::setGpuTexture("output", tex.id);
    return;
  }

  const Case& c = s->cases[idx];
  if (c.kind == AsVec && c.nComps > 0) {
    auto arr = val::Value(val::array());
    for (int i = 0; i < c.nComps; ++i) {
      auto n = val::Value(val::number(c.comps[i]));
      val::push(arr.h, n.h);
    }
    state::setValPath("output", arr.h);
    return;
  }

  // Float, and also the nothing-wired-yet resting state: an unconnected switch
  // publishes 0 rather than going silent, so a downstream wire always reads a
  // current value (the sibling shapers' contract).
  auto v = val::Value(val::number(c.scalar));
  state::setValPath("output", v.h);
}

void on_state_patched(void* self, int n, const char* pb, const int* off,
                      const int* len, const int* ops) {
  auto* s = static_cast<State*>(self);
  if (!s) return;
  for (int i = 0; i < n; i++) {
    if (ops[i] != state::PatchReplace) continue;
    const char* p = pb + off[i];
    const int l = len[i];
    if (state::pathIs(p, l, "select"))      { s->select = state::patchFloat(i); continue; }
    if (state::pathIs(p, l, "input_count")) { s->count  = state::patchInt(i);   continue; }
    // "case_<k>", k in 1..kMaxCases — matched directly rather than formatting
    // 8 candidate names per patch entry (same shape as mod_math's).
    if (l == 6 && std::memcmp(p, "case_", 5) == 0) {
      const int k = p[5] - '1';
      if (k < 0 || k >= kMaxCases) continue;
      Case& c = s->cases[k];
      // The patch's VALUE type is how a vec case distinguishes itself from a
      // float one — the schema can't say, because `any` doesn't know either.
      auto patch = val::Value(state::getPatch(i));
      auto v = val::Value(val::get(patch.h, "value"));
      if (val::typeOf(v.h) == val::Array) {
        const int have = val::length(v.h);
        c.nComps = have < kMaxComps ? have : kMaxComps;
        for (int j = 0; j < c.nComps; ++j) {
          auto e = val::Value(val::getIndex(v.h, j));
          c.comps[j] = static_cast<float>(val::asNumber(e.h));
        }
        c.kind = AsVec;
      } else {
        c.scalar = static_cast<float>(val::asNumber(v.h));
        c.kind = AsFloat;
      }
    }
  }
}

void render(void* self, int vp_w, int vp_h) {
  (void)self; (void)vp_w; (void)vp_h;   // pure data module
}

}  // namespace mod_switch
