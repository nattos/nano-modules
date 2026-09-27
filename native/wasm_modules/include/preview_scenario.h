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
 *     "params":  { "<field>": <number> | [<number>…4] | "<string>" },
 *                                        // overrides on the previewed effect
 *     "pre": [                           // linear stages AHEAD of the effect
 *       { "key": "mv", "effect": "<effect id>", "params": { … } }
 *     ],
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
 *     "loop":    <seconds>,              // hover preview loop (default 4)
 *     "output":  "<field>",              // modulation effects: the output to
 *                                        // plot (default: the primary one)
 *     "plot":    ["<key>.<field>"],      // ghost series under that plot
 *     "thumb":   "icon"                  // nothing to show: a category tile
 *   }
 *
 * `$self` names the previewed effect. Generator keys are the web preview
 * engine's input pictures (web/src/preview/generators.ts): "motion",
 * "gradient", "edges", "blobs". An unknown key falls back to "motion".
 *
 * `pre` stages sit on the image chain between the input and the effect (for an
 * effect that reads something only an upstream stage makes, like motion.blur's
 * motion vectors); `aux` helpers are sidecar-canvas nodes that only reach the
 * effect over wires. `param`s of either are set with auxParam(key, …).
 *
 * Header-only, no allocation, no libc formatting: fixed-size tables, and all
 * strings passed in must be literals (or otherwise outlive json()).
 */

namespace nano {

class PreviewScenario {
public:
    static constexpr int kMaxAux = 8;
    static constexpr int kMaxPre = 4;
    static constexpr int kMaxParams = 32;
    static constexpr int kMaxWires = 12;
    static constexpr int kMaxPlot = 4;

    /// The sketch's input picture (a generator key, or "none").
    PreviewScenario& input(const char* generator) { input_ = generator; return *this; }
    /// Override a field of the previewed effect: a number, a vector of 2-4
    /// (colours, points), or a string (paramStr).
    PreviewScenario& param(const char* field, float v) { return addParam(nullptr, field, &v, 1); }
    PreviewScenario& param(const char* field, float x, float y) { const float v[] = {x, y}; return addParam(nullptr, field, v, 2); }
    PreviewScenario& param(const char* field, float x, float y, float z) { const float v[] = {x, y, z}; return addParam(nullptr, field, v, 3); }
    PreviewScenario& param(const char* field, float x, float y, float z, float w) { const float v[] = {x, y, z, w}; return addParam(nullptr, field, v, 4); }
    PreviewScenario& paramStr(const char* field, const char* s) { return addStr(nullptr, field, s); }
    /// Add a linear stage ahead of the previewed effect (see `pre` above).
    PreviewScenario& pre(const char* key, const char* effectId) {
        if (nPre_ < kMaxPre) pre_[nPre_++] = {key, effectId, nullptr};
        return *this;
    }
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
    /// Override a field of the helper (or pre stage) `key`.
    PreviewScenario& auxParam(const char* key, const char* field, float v) { return addParam(key, field, &v, 1); }
    PreviewScenario& auxParam(const char* key, const char* field, float x, float y, float z) { const float v[] = {x, y, z}; return addParam(key, field, v, 3); }
    PreviewScenario& auxParam(const char* key, const char* field, float x, float y, float z, float w) { const float v[] = {x, y, z, w}; return addParam(key, field, v, 4); }
    PreviewScenario& auxParamStr(const char* key, const char* field, const char* s) { return addStr(key, field, s); }
    /// Wire `<key>.<field>` → `<key>.<field>` (`$self` = the previewed effect).
    /// `combine` / `magnitude` take the wire vocabulary; nullptr = default.
    /// `mixFactor` (for combine "mix"): < 0 = default.
    PreviewScenario& wire(const char* src, const char* dest,
                          const char* combine = nullptr,
                          const char* magnitude = nullptr,
                          float mixFactor = -1.f) {
        if (nWires_ < kMaxWires) wires_[nWires_++] = {src, dest, combine, magnitude, mixFactor};
        return *this;
    }
    /// Time (seconds) the thumbnail is captured at.
    PreviewScenario& capture(float seconds) { capture_ = seconds; return *this; }
    /// Length (seconds) of the hover preview's loop (and a graph's span).
    PreviewScenario& loop(float seconds) { loop_ = seconds; return *this; }
    /// Modulation effects: plot this output instead of the primary one.
    PreviewScenario& output(const char* field) { output_ = field; return *this; }
    /// Modulation effects: draw `<key>.<field>` ghosted under the plot (e.g.
    /// the signal a shaper reshapes).
    PreviewScenario& plot(const char* src) {
        if (nPlot_ < kMaxPlot) plot_[nPlot_++] = src;
        return *this;
    }
    /// Nothing worth rendering (a pass-through utility): the store shows the
    /// effect's category tile instead of a thumbnail.
    PreviewScenario& thumbIcon() { icon_ = true; return *this; }

    /// Serialize. The pointer is into this object — use it before it dies.
    const char* json() {
        len_ = 0;
        raw("{\"v\":1");
        if (input_) { raw(",\"input\":"); str(input_); }
        raw(",\"params\":");
        paramsOf(nullptr);
        if (nPre_) {
            raw(",\"pre\":[");
            for (int i = 0; i < nPre_; ++i) {
                if (i) raw(",");
                raw("{\"key\":"); str(pre_[i].key);
                raw(",\"effect\":"); str(pre_[i].effect);
                raw(",\"params\":");
                paramsOf(pre_[i].key);
                raw("}");
            }
            raw("]");
        }
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
            if (wires_[i].mixFactor >= 0.f) { raw(",\"mixFactor\":"); num(wires_[i].mixFactor); }
            raw("}");
        }
        raw("]");
        if (capture_ >= 0.f) { raw(",\"capture\":"); num(capture_); }
        if (loop_ > 0.f) { raw(",\"loop\":"); num(loop_); }
        if (output_) { raw(",\"output\":"); str(output_); }
        if (nPlot_) {
            raw(",\"plot\":[");
            for (int i = 0; i < nPlot_; ++i) {
                if (i) raw(",");
                str(plot_[i]);
            }
            raw("]");
        }
        if (icon_) raw(",\"thumb\":\"icon\"");
        raw("}");
        buf_[len_ < kBuf ? len_ : kBuf - 1] = 0;
        return buf_;
    }

private:
    static constexpr int kBuf = 8192;
    struct Aux { const char* key; const char* effect; const char* generator; };
    /// n = 1 a number, 2-4 a vector, 0 a string (`text`).
    struct Param { const char* owner; const char* field; float v[4]; int n; const char* text; };
    struct Wire { const char* src; const char* dest; const char* combine; const char* magnitude; float mixFactor; };

    PreviewScenario& addParam(const char* owner, const char* field, const float* v, int n) {
        if (nParams_ < kMaxParams) {
            Param& p = params_[nParams_++];
            p = {owner, field, {0.f, 0.f, 0.f, 0.f}, n, nullptr};
            for (int i = 0; i < n; ++i) p.v[i] = v[i];
        }
        return *this;
    }
    PreviewScenario& addStr(const char* owner, const char* field, const char* s) {
        if (nParams_ < kMaxParams) params_[nParams_++] = {owner, field, {0.f, 0.f, 0.f, 0.f}, 0, s ? s : ""};
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
            const Param& p = params_[i];
            str(p.field);
            raw(":");
            if (p.n == 0) {
                text(p.text);
            } else if (p.n == 1) {
                num(p.v[0]);
            } else {
                raw("[");
                for (int k = 0; k < p.n; ++k) { if (k) raw(","); num(p.v[k]); }
                raw("]");
            }
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
    /// A JSON string VALUE (free text, e.g. a text effect's content): escaped,
    /// not stripped. A string cut off by a full buffer is still closed.
    void text(const char* s) {
        static const char hex[] = "0123456789abcdef";
        put('"');
        for (; s && *s && len_ < kBuf - 8; ++s) {
            const unsigned char c = (unsigned char)*s;
            if (c == '"' || c == '\\') { put('\\'); put((char)c); }
            else if (c == '\n') { put('\\'); put('n'); }
            else if (c == '\t') { put('\\'); put('t'); }
            else if (c < 0x20) { raw("\\u00"); put(hex[c >> 4]); put(hex[c & 15]); }
            else put((char)c);
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
    const char* output_ = nullptr;
    bool icon_ = false;
    Aux pre_[kMaxPre] = {};
    Aux aux_[kMaxAux] = {};
    const char* plot_[kMaxPlot] = {};
    Param params_[kMaxParams] = {};
    Wire wires_[kMaxWires] = {};
    int nPre_ = 0, nAux_ = 0, nParams_ = 0, nWires_ = 0, nPlot_ = 0;
    float capture_ = -1.f;
    float loop_ = 0.f;
    char buf_[kBuf] = {};
    int len_ = 0;
};

}  // namespace nano
