#pragma once
/**
 * nano::PreviewScenario — how an effect asks to be shown in the effect store.
 *
 * The web editor's effect store renders every effect's thumbnail (and a live
 * preview on hover) by running a tiny sketch through the WebGPU executor. By
 * default that sketch is just the effect on an animated test input. An effect
 * whose look only shows up with the right setup — a blend needs a second
 * input, a motion blur needs motion, a parameter is best seen swept — declares
 * a SCENARIO instead. It is built here, inside the effect's own wasm, at
 * registration, and crosses the ABI as the `preview` metadata string:
 *
 *   nano::EffectBuilder("composite.blend")
 *       ...
 *       .preview(nano::PreviewScenario()
 *                    .input("motion")                  // chain input → tex_a
 *                    .auxGenerator("b", "edges")       // a second picture
 *                    .wire("b.output", "$self.tex_b")
 *                    .aux("lfo", "mod.source.lfo").auxParam("lfo", "rate", 0.25f)
 *                    .wire("lfo.output", "$self.opacity")
 *                    .capture(1.5f)
 *                    .json())
 *       .register_();
 *
 * (The temporary lives until the end of that full statement, which is all
 * registration needs: the host copies the string during register_().)
 *
 * JSON contract (read by web/src/preview/scenario.ts; unknown keys ignored):
 *
 *   {
 *     "v": 1,
 *     "input":   "<generator key>",      // the sketch's input picture; "none"
 *                                        // for none. Omitted → "motion".
 *     "params":  { "<field>": <number> },// overrides on the previewed effect
 *     "aux": [                           // helper nodes, off the image chain
 *       { "key": "lfo", "effect": "<effect id>", "params": { … } },
 *       { "key": "b",   "generator": "<generator key>" }
 *     ],
 *     "wires": [
 *       { "src": "<key>.<field>", "dest": "<key>.<field>",
 *         "combine"?: "replace|mix|add|mul", "magnitude"?: "…",
 *         "mixFactor"?: <number> }
 *     ],
 *     "capture": <seconds>,              // thumbnail time (default 1.5)
 *     "loop":    <seconds>               // hover preview loop (default 4)
 *   }
 *
 * `$self` names the previewed effect. Generator keys are the web preview
 * engine's input pictures (web/src/preview/generators.ts): "motion",
 * "gradient", "edges", "blobs". An unknown key falls back to "motion".
 *
 * Header-only, no allocation, no libc formatting: fixed-size tables, and all
 * strings passed in must be literals (or otherwise outlive json()).
 */

namespace nano {

class PreviewScenario {
public:
    static constexpr int kMaxAux = 8;
    static constexpr int kMaxParams = 24;
    static constexpr int kMaxWires = 12;

    /// The sketch's input picture (a generator key, or "none").
    PreviewScenario& input(const char* generator) { input_ = generator; return *this; }
    /// Override a field of the previewed effect.
    PreviewScenario& param(const char* field, float v) { return addParam(nullptr, field, v); }
    /// Add a helper effect node, addressed as `key` in wires.
    PreviewScenario& aux(const char* key, const char* effectId) {
        if (nAux_ < kMaxAux) aux_[nAux_++] = {key, effectId, nullptr};
        return *this;
    }
    /// Add a helper picture from one of the store's input generators.
    PreviewScenario& auxGenerator(const char* key, const char* generator) {
        if (nAux_ < kMaxAux) aux_[nAux_++] = {key, nullptr, generator};
        return *this;
    }
    /// Override a field of the helper node `key`.
    PreviewScenario& auxParam(const char* key, const char* field, float v) {
        return addParam(key, field, v);
    }
    /// Wire `<key>.<field>` → `<key>.<field>` (`$self` = the previewed effect).
    /// `combine` / `magnitude` take the wire vocabulary; nullptr = default.
    PreviewScenario& wire(const char* src, const char* dest,
                          const char* combine = nullptr,
                          const char* magnitude = nullptr) {
        if (nWires_ < kMaxWires) wires_[nWires_++] = {src, dest, combine, magnitude};
        return *this;
    }
    /// Time (seconds) the thumbnail is captured at.
    PreviewScenario& capture(float seconds) { capture_ = seconds; return *this; }
    /// Length (seconds) of the hover preview's loop.
    PreviewScenario& loop(float seconds) { loop_ = seconds; return *this; }

    /// Serialize. The pointer is into this object — use it before it dies.
    const char* json() {
        len_ = 0;
        raw("{\"v\":1");
        if (input_) { raw(",\"input\":"); str(input_); }
        raw(",\"params\":");
        paramsOf(nullptr);
        raw(",\"aux\":[");
        for (int i = 0; i < nAux_; ++i) {
            if (i) raw(",");
            raw("{\"key\":"); str(aux_[i].key);
            if (aux_[i].effect) { raw(",\"effect\":"); str(aux_[i].effect); }
            if (aux_[i].generator) { raw(",\"generator\":"); str(aux_[i].generator); }
            raw(",\"params\":");
            paramsOf(aux_[i].key);
            raw("}");
        }
        raw("],\"wires\":[");
        for (int i = 0; i < nWires_; ++i) {
            if (i) raw(",");
            raw("{\"src\":"); str(wires_[i].src);
            raw(",\"dest\":"); str(wires_[i].dest);
            if (wires_[i].combine) { raw(",\"combine\":"); str(wires_[i].combine); }
            if (wires_[i].magnitude) { raw(",\"magnitude\":"); str(wires_[i].magnitude); }
            raw("}");
        }
        raw("]");
        if (capture_ >= 0.f) { raw(",\"capture\":"); num(capture_); }
        if (loop_ > 0.f) { raw(",\"loop\":"); num(loop_); }
        raw("}");
        buf_[len_ < kBuf ? len_ : kBuf - 1] = 0;
        return buf_;
    }

private:
    static constexpr int kBuf = 4096;
    struct Aux { const char* key; const char* effect; const char* generator; };
    struct Param { const char* owner; const char* field; float value; };
    struct Wire { const char* src; const char* dest; const char* combine; const char* magnitude; };

    PreviewScenario& addParam(const char* owner, const char* field, float v) {
        if (nParams_ < kMaxParams) params_[nParams_++] = {owner, field, v};
        return *this;
    }
    static bool same(const char* a, const char* b) {
        if (a == b) return true;
        if (!a || !b) return false;
        while (*a && *a == *b) { ++a; ++b; }
        return *a == *b;
    }
    void paramsOf(const char* owner) {
        raw("{");
        bool first = true;
        for (int i = 0; i < nParams_; ++i) {
            if (!same(params_[i].owner, owner)) continue;
            if (!first) raw(",");
            first = false;
            str(params_[i].field);
            raw(":");
            num(params_[i].value);
        }
        raw("}");
    }
    void put(char c) { if (len_ < kBuf - 1) buf_[len_++] = c; }
    void raw(const char* s) { while (*s) put(*s++); }
    /// A JSON string literal. Keys and ids are plain ASCII identifiers; quotes,
    /// backslashes and control bytes are dropped rather than escaped.
    void str(const char* s) {
        put('"');
        for (; s && *s; ++s) {
            const unsigned char c = (unsigned char)*s;
            if (c < 0x20 || c == '"' || c == '\\') continue;
            put((char)c);
        }
        put('"');
    }
    void num(float v) {
        if (!(v == v)) v = 0.f;  // NaN → 0
        if (v < 0.f) { put('-'); v = -v; }
        if (v > 1e9f) v = 1e9f;
        long whole = (long)v;
        long frac = (long)((v - (float)whole) * 10000.f + 0.5f);
        if (frac >= 10000) { whole += 1; frac -= 10000; }
        char digits[24];
        int n = 0;
        do { digits[n++] = (char)('0' + whole % 10); whole /= 10; } while (whole > 0);
        while (n > 0) put(digits[--n]);
        put('.');
        put((char)('0' + (frac / 1000) % 10));
        put((char)('0' + (frac / 100) % 10));
        put((char)('0' + (frac / 10) % 10));
        put((char)('0' + frac % 10));
    }

    const char* input_ = nullptr;
    Aux aux_[kMaxAux] = {};
    Param params_[kMaxParams] = {};
    Wire wires_[kMaxWires] = {};
    int nAux_ = 0, nParams_ = 0, nWires_ = 0;
    float capture_ = -1.f;
    float loop_ = 0.f;
    char buf_[kBuf] = {};
    int len_ = 0;
};

}  // namespace nano
