# Effects Catalogue — Legacy Collections (Wire + dnode)

A survey of effects we've built before, catalogued so we can pick which ones to crack open and port to nano-modules. Two collections, very different in nature:

- **Wire** — patches authored in **Resolume Wire** (the commercial node-graph effect editor). 104 patches, each a `.wire` JSON node-graph. Logic is built from Wire's built-in nodes plus, in ~34 cases, custom **ISF** (GLSL) shaders bundled under each patch's `Resource/ISF/`. Fully inspectable. Root: `~/Library/CloudStorage/GoogleDrive-natnyo@gmail.com/My Drive/Resolume/Wire/Patches`.
- **dnode** (a.k.a. **NanoGraph** — the direct ancestor of nano-modules) — our own framework: UI on Unity's *Bolt* visual scripting, but execution via native **Metal compute-kernel** code-generation, shipped as **FFGL plugins** for Resolume. **These are the only effects we've actually shipped to live events**, so they're the highest-value port targets. 37 shipped bundles at `~/Code/dnode/Products/*.bundle`; readable source at `~/Code/dnode/Assets/NanoGraph/` (`*.asset` = Bolt graph; `*.txt` = generated Metal kernel).

How entries were derived: Wire entries from the patch's node-name histogram + reading the custom ISF GLSL where present. dnode entries from reading the generated Metal kernels (`.txt`) **and the decoded Bolt graph** — the `.asset` YAML wraps a `_data._json` string holding the full graph as JSON (strip the 3 Unity header lines, `json.loads` the inner string; all 37 decode). That graph yields each effect's complete **exposed parameter surface** and its embedded `ExpressionNode` math (recurrences, force fields), so every dnode entry below lists its real parameters. (Node *defaults* live in the `$ref` wiring, not yet resolved, so exact default knob values aren't quoted.) Each entry lists **What it does / Technique / Complexity / Port interest / Parameters / Source**.

Glossary (dnode): **Ponk** = laser/line-point output format; **Tri** = textured-triangle output; **LCG** = `*22695477+1` linear-congruential PRNG used as the per-particle random source. **SPHR** = equirectangular sphere/LED-dome projected.

---

## Real-world usage & port priority (team-validated)

This list comes from how these effects were *actually* used live — it supersedes the analytic "Curated port shortlist" below wherever they disagree (the analytic list ranks by distinctiveness; this one by real play-time and demand).

**Cross-cutting decisions that shape every port:**
- **PONK/laser output is not used.** Ports should target texture output (and, where effects pass data between stages, **struct-typed outputs**), not the Ponk laser path. The Ponk passes in Chamber/Darkburst/Mad*/etc. can be dropped.
- **"v2" rewrites are welcome over direct ports** for the older/inefficient effects (DoubleChamber, ChromaWobble, the Wobble Master family). Prefer re-architecting for efficiency to faithfully reproducing the old graph.
- Several **SPHR** effects are useful **even when not mapped to a sphere** (SPHR Blur, SPHR BicolorGrad) — don't gate them behind a spherical-display assumption.

### Tier A — actively used, port early

- **BicolorGrad** — used as-is.
- **Glisten** — used as-is.
- **DoubleChamber** — our "all-in" particle effect to date. In practice the **"particle accelerator" bits are almost always OFF**; what we use is the **particles, "bridgers" (in bursts), the curl, and the tracers**. No PONK. Old — **open to a v2** with upgraded compute/render. Could be split into a constellation of struct-output effects, but that risks making it *harder* to use; decide deliberately.
- **Darkburst** — in practice we **turn off everything except the distortion field ("D wave")**; the rest is rarely used. No PONK. Could be reorganized as separate effects with struct outputs between them if needed for efficiency.
- **Burn Out** — useful for more emotional "fade outs."
- **ChromaWobble** — needs re-architecting; **open to a v2** for efficiency.
- **Freeze Pulse** — very useful.
- **LUT 2** — keep, but **implement more efficiently**. The baked static LUT resources are good as-is — happy to keep them.
- **SPHR Blur** — amazingly useful **even off-sphere**. Math is likely wrong but the look is fine; don't over-invest in "correctness."
- **Stutter Scale 2** — very useful for overlays and logos.
- **Subtle Blur** — good for breaking up sharp edges.
- **Wobble Master / Wobble Master 2 / Fast** — useful but **likely needs re-architecting** (v2).
- **ZoomScroller** — very useful for idle moments.

### Tier B — good, lower priority

- **SPHR BicolorGrad** — useful **even when not on a sphere**.
- **SPHR Magneto Dynamics** — very unique; takes full advantage of spherical displays. *(Shipped bundle/asset files misspell it "Magento".)*
- **SPHR Rand Billboard** — easy way to fill a spherical display, but **very buggy — has visual artifacts** (fix on port).
- **SPHR Billboard**.
- **Character Sweeper**, **Character Prompter** — text effects.
- **Glitch Revolver 2**.
- **HVEN Sphere Sim**.
- **Horizontal Glitch**.
- **Pixulant** — the shader is a bit weird / has dead code, but **infinitely useful**. The "dive" reportedly relied on a quirk of Wire's *difference* blend mode: subtracting an image from itself didn't yield pure black — it left a halo. A faithful port must **deliberately reproduce or replace that non-black-difference behavior** (it's load-bearing, not a bug).
- **Pulsed Tunnel 2**.

---

## Curated port shortlist (analytic — see team list above for real priority)

Ranked by distinctiveness + how cleanly each maps onto nano-modules' compute/particle/feedback model. Skip the dozens of trivial blend/alpha/color utilities (clearly marked "trivial/utility" below) — nano-modules already has those primitives.

### Tier 1 — shipped, proven, and genuinely distinctive (start here)

These are dnode effects that ran at live events and have no easy equivalent elsewhere:

- **Chamber / DoubleChamber** — charged-particle collision sims (curl steering, image-driven collisions, exponential energy decay, stochastic branching spawn). The signature look. Maps to a GPU particle pool + Ponk/line output.
- **FTLStream** — image-reactive 3D "warp-speed" streamline sim with a spherical boundary bubble; 128-step inner integration per particle.
- **LineCannon** — image-following gradient-descent line tracers with momentum and trailing fade (ring-buffer paths).
- **MadPoints** — image-seeded falling-particle attractor (gravity + center-sink) with envelope-driven flash selection.
- **MadScanner** — trigger/rate-clock "slash" beam generator: a growing flaring flash-quad + flickering Ponk laser line + a distortion-field hand-off. (Mad* laser-beam family; the decoded kernel corrected an earlier mis-read of this as a blob analyzer.)
- **Darkburst** — gradient-descent particles self-organizing into bursting star shapes (laser output).
- **GenIkedaMap / GenLogisticMap / LogisticRadial** — self-contained chaotic-attractor / bifurcation generators. Trivially portable; high visual payoff per line of code.
- **SPHR Magneto Dynamics** — magnetic-dipole / curl-field particle dynamics on a sphere. *(Shipped files misspell it "Magento".)*
- **SPHR Rand Billboard** — scattered textured billboards on a dome with correct equirectangular seam + z-plane clipping (the clipping math is the reusable gem).
- **Glisten** — coarse/fine image anchor-finding + gradient-shaded stretched sparkle fans.

### Tier 2 — Wire effects with a clean, distinctive compute story

- **3D Chen Attractor** — a hand-wired ODE integrator with feedback state; collapse into one attractor compute kernel.
- **Dynamical / Flow & Diverge / Flow & Diverge Self** — iterative flow-field advection (8-sample max-gradient probe + feedback buffer). Natural ping-pong compute port; pick one as the base.
- **Simulant family** (Simulant, 2nd Order, MarkII, HQ) — reaction-diffusion-style "growth" feedback (edge-detect → posterize → levels → zoom feedback, some with a hand-rolled spring solver). Port base Simulant, parameterize the rest.
- **Pulsed Tunnel / Pulsed Tunnel 2** — generative noise-tunnel with feedback trails; #2 is beat-reactive radial pinch.
- **Pixulant / SPHR Pixulant** — scatter-feedback "dive" aesthetic (Radial Stretch + frame Difference core).
- **LED-dome projector** — `HVEN Sphere Sim` / `SPHR Rotate` / `SPHR Quantize` all wrap one rich ISF: screen→sphere unproject, 48×5 panel gaps, UV quantization. Port the shader once; the node graphs are just parameter plumbing.
- **Equirect primitives** — `SPHR Expand` (sphere-aware morphological dilate/erode), `SPHR Blur` (seam-correct blur), `SPHR Displace/Grad` (luma-gradient warp). Clean reusable infrastructure for any spherical pipeline.
- **Glitch shaders** — `Horizontal Glitch` (per-scanline noise displacement), `Glitch Revolver 1/2` (radial packed-offset block shift), `Horizontal Striation` (row-wise max-saturation reduction).
- **Chroma/wobble** — `Wobble Master 2` carries a reusable YIQ `ChromaOffset` shader (hue-rotated chromatic aberration via displacement map); `ChromaWobble` and `Sinkhole` are smaller cousins.
- **Whisp It** — full advection/feedback smoke dissolve with crop+mask rig (large but rich).

### Tier 3 — control rigs / sequencers worth lifting as logic (not shaders)

- **ZoomScroller** — procedural pan/zoom sequence camera with sub-step tweening.
- **Anim Grid** — per-tile cell scheduler with per-cell state.
- **BeatSwitcher / Sampling Revolver 1&2 / Video Skippy / Stutter Scale** — beat-synced switching, playhead-slip, and scale-stutter timing engines. Visual op is simple; the scheduling logic is the value.
- **Trianguplace** — procedural triangle-tiling/coverage algorithm.
- **The Complex Sim** — data-driven (bag/sort/shuffle) light-grid composition engine.

### Notable duplicates — port once

`SPHR Rotate` ≈ `SPHR Rotate Yaw-Pitch`; `SPHR Displace` ≈ `SPHR Displace Grad`; `Wobble Master 2` ≈ `Wobble Master Fast` (perf variant); `Stutter Scale` ≈ `Stutter Scale 2`; `Glitch Revolver` ≈ `Glitch Revolver 2`; `Sampling Revolver` ≈ `Sampling Revolver 2`; `Alpha Modulate`/`Luma Modulate` (ISF) ≈ their `… 2` node-only reimplementations; `Simuline` is the static core of `Simulant`.

---

# dnode / NanoGraph — Shipped Effects Catalogue

Node-based visual framework (UI built on Unity's Bolt visual scripting) whose execution is native code generation — Metal compute kernels shipped as FFGL plugins for Resolume. These are the team's proven, shipped-at-live-events effects and are the prime port candidates. 37 shipped bundles below.

Notes on terms used throughout: **Ponk** = laser/line-point output format (Pangolin/laser path points); **Tri** = textured-triangle output; **LCG** = `*22695477+1` linear-congruential PRNG used as the per-particle/per-pixel random source.

---

## Infrastructure / plumbing (not visual effects)

- **Add Blue** — utility node, adds/injects the blue channel. No asset, no kernel. Port interest: n/a.
- **Add Red** — utility node, adds/injects the red channel. No asset, no kernel. Port interest: n/a.
- **IO Export** — I/O plumbing node (export a buffer/texture out of the graph). No asset/kernel. Port interest: n/a.
- **IO Peek** — I/O plumbing node (non-destructive read of a queue/stack). No asset/kernel. Port interest: n/a.
- **IO Pop** — I/O plumbing node (pop from a queue/stack). No asset/kernel. Port interest: n/a.
- **IO Push** — I/O plumbing node (push to a queue/stack). No asset/kernel. Port interest: n/a.
- **NanoFFGL** — the FFGL host/runtime shell that wraps the generated effects as a Resolume plugin. Infrastructure, not an effect.
- **Program** — generic program/host scaffold node. Infrastructure, not an effect.

---

## Visual effects

### BicolorGrad
- **What it does:** Analyzes an input image to extract two dominant complementary hues (a "major" peak and an angularly-isolated "minor", plus a derived "off" color) and locates their spatial centroids, producing a center point and a normalized gradient direction spanning from minor- to major-color regions. Drives a content-adaptive two-color gradient overlay aligned to the image's actual color layout.
- **Technique:** A TextureCompute preprocessing pass converts RGB→YIQ to derive per-pixel hue/chroma/luma (`hue = atan2(Q, I)/(2pi)`, `chroma = sqrt(I*I+Q*Q)`), then an atomic histogram pass scatters into a 64-bin hue buffer (`atomic_fetch_add_explicit(&(output0[(int)round(Index)]), (int)round(16 * Amount), ...)`). **FindColors** kernel: walks the 64-bin histogram, picks the peak as `majorBucket` with parabolic sub-bin interpolation (`(w2 - w0)/w1 * 0.5 + bestBucket`), then re-scans for `minorBucket` weighting each bin by a squared isolation falloff `saturate(abs(i - majorBucket)/BucketCount/IsolationWidth)^2` (IsolationWidth=0.3) to force angular separation; derives `offBucket = majorBucket + fmod(majorMinorDiff,0.5)*0.5`; reconstructs MajorColor/MinorColor/OffColor via HSL→YIQ→RGB, blending toward NeutralColor by an `atan`-confidence weight. **LocateColors** kernel: 16x16 UV grid, accumulates weighted centroids using `major/minorWeight = sample.x/y * sample.z`, emits `Center = (majorAcc+minorAcc)*0.5*2-1` and `Direction = normalize(majorAcc-minorAcc) * DirectionSign`.
- **Complexity:** Medium (2 codegen kernels + histogram/HSL preprocessing; peak-picking + centroid reduction, no simulation).
- **Port interest:** Medium — content-adaptive palette extraction feeding a gradient; a reusable color-statistics building block, not a generative sim.
- **Parameters (6):** Temporal Smoothing, Neutral R, Neutral G, Neutral B, Reverse, Scale
- **Key expressions:** RGB→YIQ hue extract `float hue = abs(I) <= (1.0/(256*256)) ? 0.0 : atan2(Q, I); float chroma = sqrt(I*I + Q*Q); hue /= Pi*2; hue -= floor(hue);`; histogram scatter `atomic_fetch_add_explicit(&(output0[(int)round(Index)]), (int)round(16 * Amount), memory_order_relaxed)`
- **Source:** `dnode/Products/BicolorGrad.bundle` (+ kernels: BicolorGradFindColors.txt, BicolorGradLocateColors.txt)

### CalcBuckets
- **What it does:** Builds a per-channel intensity histogram of an input image and converts it into a quantized cumulative-distribution tone-mapping ramp (a histogram-equalization-style transfer curve) with adjustable level count and gamma.
- **Technique:** **CalcBuckets** kernel: samples a 64x64 grid (`gid % 64`, `gid / 64`), and for each of channels R/G/B atomically increments a 256-bin histogram offset per channel into one buffer (`atomic_fetch_add_explicit(&(outCounts[bucket + channel*256]), 1, ...)`, `bucket = round(sample[channel]*256)`). **CalcBucketsCollect** kernel: per channel (`indexOffset = gid * 256`) walks the 256 bins accumulating a running count, maps the cumulative fraction to a discrete level `newLevel = floor(acc/TotalCount * Levels)` (TotalCount = 64*64), and emits a stepped ramp shaped by `pow(saturate(newLevel/Levels), ColorCurve)`.
- **Complexity:** Low/Medium (2 kernels; atomic histogram + prefix-sum CDF).
- **Port interest:** Low — standard histogram/CDF tone-curve utility, no spatial or generative novelty.
- **Parameters (2):** Levels, Curve
- **Source:** `dnode/Products/CalcBuckets.bundle` (+ kernels: CalcBuckets.txt, CalcBucketsCollect.txt)

### CalcMean
- **What it does:** Computes the average color of an input image (a single RGBA mean), used as a global color/brightness summary; exposed mid/contrast params feed a downstream remap.
- **Technique:** Single **CalcMean** kernel: loops a 7x7 inner set (GridSize=8, `x,y < GridSize-1`) of bilinear-filtered (`filter::linear, address::clamp_to_edge`) samples at `texelSize*float2(x,y) + 0.5/GridSize`, accumulates into a float4 and divides by `(GridSize-1)^2 = 49`, outputting `Mean`. The Color Mid / Alpha Mid / Contrast params are applied in graph Math nodes outside this reduction kernel.
- **Complexity:** Low (1 kernel, trivial averaging reduction).
- **Port interest:** Low — a basic image-mean statistic / helper.
- **Parameters (3):** Color Mid, Alpha Mid, Contrast
- **Source:** `dnode/Products/CalcMean.bundle` (+ kernels: CalcMean.txt)

### Chamber
- **What it does:** A charged-particle "cloud chamber" sim. Typed agents (charge/mass/velocity presets) stream through the scene tracing curved line trails that curl by charge/mass, get deflected when they hit bright regions of the input image, lose energy over time, and on termination stochastically spawn 0–2 typed child agents — producing organic branching laser-line trails.
- **Technique:** Multi-pass GPU agent pool. `ChamberSpawn` runs the per-agent stepping loop (`MaxSteps=1024`): step size `0.03`, curl rotation `curl = 0.1 * charge / mass / Scale`, LCG (`*22695477+1`) random-walk perturbation scaled by sampled image brightness and `1/(energy+4)`, energy recurrence `nextEnergy = energy*EnergyDecayFactor - EnergyDecayLinear` with `EnergyThreshold` death. A probabilistic collision (Type-1 only) when `value > pCollisionThreshold && pRand < CollisionRate` applies `atan(dir·CollisionDeflectionSquash)`-softened deflection and `mix(LossMax,LossMin)` energy loss, optionally entering a second image-displaced phase. On stop it rolls `nextSpawnCase = (int)(pNextSpawnCase*10)` (0–9) and atomically emits child agents of types 1–4 via `atomic_fetch_add(outCounter[1])`. `Chamber.txt` is the companion gradient-following pass: 4-tap finite-difference image gradient builds a tangent blended `mix(mix(tangentDir,gradDir,GradientDescent),dir,Momentum)`, runs forward+reverse from the seed, stops below `ValueStopThreshold`/`GradStopThreshold`, recycles dead threads by `RejectionSampleTries` brightest-of-N sampling, and reverses ponk-point order for clean laser paths. `ChamberSpawnSelect` biases spawn positions onto existing line vertices (`pIsLine < IsLineRate`, samples a quadratic-weighted vertex along the path). `ChamberPonkPoints` emits live points as Ponk laser path points colored from `ColorTexture` via `mix(white, sample, ColorContrib)`.
- **Complexity:** High (4 kernels; stateful multi-pass particle sim with atomic spawn counters, charge-curl integration, image collision/gradient steering, rejection-sample respawn, Ponk output).
- **Port interest:** High — distinctive charged-particle/cloud-chamber sim with stochastic branching spawn and image-driven collision + gradient steering; strongly generative and visually unique.
- **Parameters (40):** Spawn Anchor X, Image Smoothing, Collision Deflection Squash, L Momentum, Spawn Rotation, Spawn Rotation Dir, Spawn Anchor Y, L Length, L Step Speed, L Adv Step Speed, L Adv Momentum, Image Smoothing Mix, Debug Image, L Glitch, Render Subgrad, L Time Stop Decay, L Value Stop Threshold, L Gradient Descent, L Time Decay, Spawn Count, L Grad Stop Threshold, Image Subsmoothing, L Count, Continue After Collision Rate, PassSameModeRate, Collision Rate, Collision Deflection, Spawn Rotation Spread, Spawn Distance, Scale, Spawn Distance Spread, Energy Decay Factor, Energy Decay Linear, Energy Threshold, Collision Threshold, Collision Energy Loss Min, Motion Speed, Random Walk Strength, Zoom, Collision Energy Loss Max.
- **Key expressions:** energy decay `nextEnergy = energy * EnergyDecayFactor - EnergyDecayLinear`; curl `curl = 0.1 * charge / (basicMass*energy*Scale) / Scale`; gradient-follow blend `normalize(mix(mix(tangentDir, gradDir, GradientDescentFactor), dir, MomentumFactor))`.
- **Source:** `dnode/Products/Chamber.bundle` (+ kernels: Chamber.txt, ChamberPonkPoints.txt, ChamberSpawn.txt, ChamberSpawnSelect.txt)

### Crystalzaic
- **What it does:** A crystalline "mosaic" warp of an input image — lays down a rotatable grid of sample points, searches a neighborhood for a local target, and displaces toward it with momentum, producing faceted crystal/Voronoi-like shards that drift over time.
- **Technique:** Confirmed graph-only (no codegen kernel). 69 nodes: a GenerateValue grid feeds a Math/ScalarCompute search loop (17 MathNode + 10 ScalarComputeNode) using Search Size to scan a neighborhood, with 3 LatchNode-held state buffers carrying per-cell position with Momentum, color picked via Color Offset; a RepackNode/TypeDecl struct rail drives a VertexShader+FragmentShader pass sampling the input ColorTexture (TextureInput). Grid Scale / Grid Density / Grid Rotate parametrize the lattice; Random Offset + Motion add per-cell jitter and animation.
- **Complexity:** Medium.
- **Port interest:** Medium — image-driven mosaic/warp, generative-ish but tied to an input texture.
- **Parameters (8):** Momentum, Random Offset, Color Offset, Motion, Search Size, Grid Scale, Grid Density, Grid Rotate
- **Source:** `dnode/Products/Crystalzaic.bundle` (no kernel — graph-only; asset Crystalzaic)

### Darkburst
- **What it does:** An envelope/audio-reactive particle system whose particles do gradient descent over a texture field and self-organize into bursting star shapes, with a separately-driven "D wave" distortion field and a glowing core, all drawn as laser lines (PonkOutput). CONFIRMED graph-only.
- **Technique:** No generated kernel — built-in nodes (319 total: 105 Math, 46 value inputs, 35 Route, 27 ScalarCompute, 11 TextureCompute, 10 Mix, PonkOutputNode, NioTextureInput, Vertex/Fragment passes). A trigger→envelope front-end (`Env Trigger/Rate/Gain/Curve/Decay/Constant`, `Env Rate Curve`) drives multiple `> ` routing params that map the envelope onto star/core/wave terms: `Star Env > Big/Points`, `Core Env > Boost`, `D Env > Rate`, `D Env > Wave Speed`. The star system (`Star Points/Decimate/Scale/Squash/Squeeze/Center Size`) builds the bursting star geometry; the "D" block (`D Rate/Density/Scale/Distortion/Squeeze`, `D Wave Speed/Decay/Soften`) is a distortion wave; the "L" block (`L State Rate/Smoothing/Back Boost/Back Rate`, `L Render Alpha`) handles laser-line state and rendering. Anchored at `Anchor X/Y`; colored via `Color Contrib`/`TexIn Color Offset`.
- **Complexity:** High (very large graph, 319 nodes / ~105 Math; envelope-routed multi-block sim, no kernel).
- **Port interest:** High — particle sim + gradient-descent star attractor + audio-envelope routing + laser output; visually strong and on-brand for the family.
- **Parameters (46):** Star Decimate, Env Rate Curve, Star Points, Core Env > Boost, D Wave Soften, Star Squash, Env Decay, D Wave Speed, D Squeeze, D Rate, D Env > Rate, Star Scale, Env Curve, D Render Alpha, L Render Alpha, Debug D Wave Alpha, L State Rate, Debug L Mask Alpha, L Back Boost, L Back Rate, Debug Input Alpha, Color Contrib, TexIn Color Offset, Env Constant, Star Center Size, Star Env > Big, Env Trigger, Env Rate, Core Env Smoothing, D Env Smoothing, Star Env > Points, Env Gain, Core Scale, Core Subsmoothing, Core Boost, Core Jitter, L Smoothing, D Density, D Scale, D Distortion, Core Smoothing, Star Squeeze, D Wave Decay, D Env > Wave Speed, Anchor X, Anchor Y.
- **Usage (team):** In practice we **turn off everything except the distortion field ("D wave")**; the other blocks are rarely used. PONK not used. Could be reorganized as separate effects with struct outputs if needed for efficiency.
- **Source:** `dnode/Products/Darkburst.bundle` (no kernel — graph-only)

### DepthEffects
- **What it does:** Projects an animated particle field into 3D camera space and renders it as polygon sprites, shaping each particle's depth (Z) and size by a deformable spherical shape field, with FOV/yaw/pitch camera framing and front/behind alpha+luminosity falloff.
- **Technique:** Graph-only (no generated kernel; 140 nodes). A single `FromEuler` ExpressionNode builds the camera basis from Pitch/Yaw — `pitchCos/Sin`, `yawCos/Sin` rotate `rightDir`, `upDir` and `forwardDir={0,0,1}` to emit `Right`/`Up`/`Forward`. A ScalarCompute (14)/Math (47) chain advances a particle set (Count, Speed, Integration Step, Momentum) inside a spherical boundary (Sphere Shape/Size/Stiffness/Intensity, Spherical Phase/Aspect/Scale), then maps depth→size (`Z > Size`) and animation→Z/size (`Anim > Z`, `Anim > Size`, Anim/Alpha Squash), feeding a Vertex+Fragment pass (polygon fans via `Poly Angle`/`Rand > Poly Angle`). FOV + View Yaw/Pitch frame it; Behind Z/Alpha/Luminosity + Infront Alpha + Contrast composite front-vs-back. Note: the graph's `title` field reads "SPHR Magneto Dynamics" (a stale copy), but the params + `FromEuler` confirm this is the camera-projected particle/shape-field effect.
- **Complexity:** Medium-High (140 nodes; camera-basis math + particle integrator + spherical boundary + 3D sprite render, no compute kernel).
- **Port interest:** Medium-High — reusable 3D-projected particle field with a physics shape boundary and clean Euler camera basis.
- **Parameters (35):** Sphere Shape, Spawn Distance, Gray, Momentum, Spherical Phase, Input Alpha, Smoothing, Sphere Size, Spawn Radius, Spherical Aspect, Max Influence, Integration Step, Sweep, Image Influence, Sphere Stiffness, Sphere Intensity, Count, Behind Z, View Yaw, Rand > Poly Angle, Poly Angle, Spherical, Alpha Squash, Z > Size, Anim > Z, Speed, Infront Alpha, Anim Squash, Spherical Scale, View Pitch, Anim > Size, FOV, Behind Luminosity, Contrast, Behind Alpha
- **Key expressions:** `FromEuler` builds the camera basis: `vector_float3 rightDir = { pitchCos, pitchSin, 0 }; rightDir = { rightDir.x*yawCos + rightDir.z*yawSin, rightDir.y, rightDir.z*yawCos - rightDir.x*yawSin }; ... vector_float3 forwardDir = { 0,0,1 }; forwardDir = { forwardDir.x*yawCos + forwardDir.z*yawSin, ... }; Right = rightDir; Up = upDir; Forward = forwardDir;`
- **Source:** `dnode/Products/DepthEffects.bundle` (no kernel — graph-only; asset DepthEffects.asset)

### DoubleChamber
- **What it does:** A large composite laser effect that runs three coupled particle systems at once and renders them as Ponk laser lines: a charged-line "K" system (the Chamber charged-particle/collision sim), a field-particle "P" system (the PetriDish polynomial vector-field sim), and a "Big" attractor/boundary system, stitched together by "Bridger" connector lines. Effectively Chamber + PetriDish fused into one graph.
- **Technique:** No generated kernel — built-in nodes (613 total: ~191 Math, ~97 value inputs, 49 ScalarCompute, 38 Pack, 33 Read, 10 TextureCompute, 6 Switch/6 Latch, 5+5 Vertex/Fragment shader passes, PonkOutputNode, NioTextureInput). The K-block reuses Chamber's collision/energy params (`K Energy Decay Factor/Linear`, `K Col Deflection(Squash)`, `K Col Energy Loss Min/Max`, `K Random Walk Strength`). The P-block reuses PetriDish's field/undertow params and the same embedded `Field Expr` vector field. The L-block is Chamber's gradient-following line tracer (`L Gradient Descent`, `L Time Decay`, `L Glitch`). Bridger params (`Bridger Rate/Hue/Alpha/Count`) draw connecting lines between systems. Output capped by `Ponk Line Limit` / `Ponk Point Limit`, colored from texture via `Color Contrib` / `TexIn Color Offset`.
- **Complexity:** High (the largest graph here, 613 nodes; three fused stateful particle systems, no kernel).
- **Port interest:** High — a genuine multi-system composite (charged-line collision + field-particle + attractor + bridging) with laser output; the most ambitious of the family.
- **Parameters (97):** K Energy Decay Linear, K Init Angle Dir, L Count, P Boundary Speed, K Energy Threshold, P To Image, K Energy Decay Factor, K Col Deflection, L Grad Stop Threshold, Image Scale, P To Big Curl, K Anchor Y, L Adv Momentum, L Momentum, Image Smoothing, K Same Mode Rate, K Init Angle, K Collision Rate, L Value Stop Threshold, K Col Continue Rate, Bridger Rate, K Col Deflection Squash, L Step Speed, L Length, K Anchor X, K Col Energy Loss Max, L Adv Step Speed, Bridger Hue, P Render Alpha, TexIn Color Offset, Color Contrib, Ponk Line Limit, Ponk Point Limit, Debug Ponk, K Col Energy Loss Min, K Render Hue, K Init Dist Spread, K Scale, K Render Alpha, K Random Walk Strength, P Render Hue, K Init Distance, K Col Threshold, K Motion Rate, Bridger Alpha, P To Big, Image Smooth Balance, Debug Image View, P Momentum Decay, P Field Scale, P Jitter, Bridger Count, Big Boundary Shrink, P Field Speed, P Count, Image Subsmoothing, Debug View, Big Speed, P TimeToLive, Big Repel Speed, P To Line Rate, P Spawn Size, P Sink, P Boundary Stiffness, Big Momentum Decay, Big Count, P Point Size, Image Smoothing Mix, P Momentum, K Count, K Init Angle Spread, P To Image Curl Direction, L Time Stop Decay, Big Direction, L Time Decay, L Gradient Descent, L Glitch, P To Big Curl Direction, Image Subsmoothing, P Undertow Skew, P Boundary, Big Momentum, Big Sink, P Undertow Squash, Big Spread Jitter, Big Curl, Big Spread, P Squash, P Field Squash, Image Smoothing, P To Image Curl, Big Curl Direction, Big Point Size, Big TimeToLive, P Field Skew, P Boundary Size, P Z Depth.
- **Key expressions:** the shared P-particle vector field `float2((x.y*x.y - 1.0 - (x.x*skew*-0.6 + skew*0.1)), (x.x + skew*0.7) * sign(x.y) * pow(abs(x.y) + 0.7 + squash*0.8, 3) * -0.1 * squash)`; conditional write `if (cond) WriteBuffer(output0, gid, value);`; spawn select `cond ? b : a`.
- **Usage (team):** Our "all-in" particle effect to date. In practice the **"particle accelerator" block is almost always OFF**; we use the **particles, "bridgers" (fired in bursts), the curl, and the tracers**. PONK not used. Old — **open to a v2** (upgraded compute/render). Splitting into a struct-output constellation is possible but may hurt usability.
- **Source:** `dnode/Products/DoubleChamber.bundle` (no kernel — graph-only)

### FTLStream
- **What it does:** Renders streaming "warp-speed" line trails flowing forward along a view axis (FTL/hyperspace), spawned on a ring around the camera and bent by a spherical boundary bubble and the input image's brightness; each particle leaves a fading 128-segment trail.
- **Technique:** Single GPU kernel (`FTLStream.txt`), stateful particle pool with time recycling. `time -= MotionSpeed*IntegrationSpeed/0.02`; on respawn (`time<=0`) seeds on a ring: `spawnNormal*sqrt(spawnDistance)*SpawnRadius + flowDir*spawnForward`, placed behind by `-SpawnDistance`, LCG-randomized. Each frame integrates `SegmentCount=128` streamline steps: samples image brightness (max of rgb), `sampleIntensity = atan(value*200)/Pi*2`; spherical SDF `sphericalSignedDist = BoundarySize - length(pos)` scaled by `mix(1, sampleIntensity, ImageInfluence)`; boundary force `grad` from `atan(dist*BoundaryStiffness)` along the spherical normal; direction blended `dir = mix(mix(flowDir, grad, influence), dir, Momentum)` then normalized; writes both endpoints of each segment. Camera basis comes from the `FromEuler` expression.
- **Complexity:** High (single kernel, but a full stateful particle sim with a 128-step inner streamline integration, SDF boundary forces, and image-field coupling).
- **Port interest:** High — distinctive image-reactive 3D streamline/attractor sim with boundary-bubble physics.
- **Parameters (33):** Spawn Radius, Sphere Size, Max Influence, Sphere Shape, Spherical Aspect, Image Influence, Smoothing, FOV, Spawn Distance, Momentum, Gray, Behind Z, Count, Sphere Intensity, Sphere Stiffness, Input Alpha, Integration Step, Spherical Phase, Spherical Scale, Spherical, Poly Angle, Anim > Size, Rand > Poly Angle, Speed, Anim > Z, Z > Size, Alpha Squash, View Yaw, View Pitch, Anim Squash, Infront Alpha, Behind Alpha, Behind Luminosity.
- **Key expressions:** direction integration `dir = mix(mix(flowDir, grad, influence), dir, Momentum)`; image intensity `atan(sampleValue*200)/Pi*2`; camera basis `FromEuler` (`pitchCos/Sin`, `yawCos/Sin` → Right/Up/Forward).
- **Source:** `dnode/Products/FTLStream.bundle` (+ kernels: FTLStream.txt)

### GenIkedaMap
- **What it does:** Generates the classic Ikeda map chaotic attractor and plots it into a density texture, with sample rotation/offset and Y scale/anchor controls.
- **Technique:** Confirmed graph-only (no codegen kernel). 36 nodes: a FillArray of `Threads` seeds feeds one ExpressionNode running the Ikeda recurrence `n` iterations, projecting the orbit onto a sample axis (`x.x*sin(SampleAngle) + x.y*cos(SampleAngle)` after subtracting SampleOffset from SampleX/SampleY); a VectorCompute/Pack rail splats results into a TextureCompute density buffer, with Contrast/ScaleY/AnchorY shaping the plot.
- **Complexity:** Low-Medium (small graph; the iteration is one embedded expression).
- **Port interest:** High — self-contained chaotic-attractor generator, very portable.
- **Parameters (9):** r, n, SampleAngle, Threads, Contrast, AnchorY, ScaleY, SampleX, SampleY
- **Key expressions:** `for (int i = 0; i < n; ++i) { float t = 0.4f - (6.0f / (1 + x.x * x.x + x.y * x.y)); float xn = 1 + r * (x.x * cos(t) - x.y * sin(t)); float yn = r * (x.x * sin(t) + x.y * cos(t)); x.x = xn; x.y = yn; } float angleSin = sin(SampleAngle); float angleCos = cos(SampleAngle); x -= SampleOffset; result = x.x * angleSin + x.y * angleCos;`
- **Source:** `dnode/Products/GenIkedaMap.bundle` (no kernel — graph-only; asset GenIkedaMap)

### GenLogisticMap
- **What it does:** Generates a logistic-map / bifurcation-style image — iterates the logistic recurrence and plots the settled orbit value, with Y scale/anchor and contrast controls.
- **Technique:** Confirmed graph-only (no codegen kernel). 29 nodes (smallest of the set): a FillArray of `Threads` feeds one ExpressionNode iterating the logistic map `n` times to a settled value, then a VectorCompute/Unpack rail splats `y` into a TextureCompute via ScaleY/AnchorY/Contrast. (The control parameter `r` is exposed as a single param here rather than swept across columns.)
- **Complexity:** Low.
- **Port interest:** High — canonical generative bifurcation/orbit visual, trivially portable.
- **Parameters (6):** Contrast, n, r, Threads, AnchorY, ScaleY
- **Key expressions:** `for (int i = 0; i < n; ++i) { x = r * x * (1 - x); } y = x;`
- **Source:** `dnode/Products/GenLogisticMap.bundle` (no kernel — graph-only; asset GenLogisticMap)

### Glisten
- **What it does:** Draws sparkle/glint "fans" — radial bursts of triangles fanning out from an anchor point, tinted by a color gradient and stretched along the gradient direction for a streaky lens-flare/glisten look. Anchors auto-locate on the brightest image spot via coarse-to-fine search and bursts ramp by level for a layered glint.
- **Technique:** Three kernels. FindAnchor: coarse-to-fine 2D max-brightness search — scans a downsampled `CoarseTexture` (1/8 res) for the brightest texel, refines within that cell on `FineTexture`, then takes a 4-tap (`±SamplingWidth`) finite-difference luminance gradient + per-channel R/G/B color gradients softened by `atan((len+ColorGradSoft)*ColorGradSquash)`, outputting Position/Direction/Grad/Color/ColorGradX/Y. Glisten: rotates a direction by a fixed `AngleStep` complex rotation to sweep `StepCount` triangles into a fan; per-level scale falloff `scale = (LevelCount*Shape)/(levelIndex + LevelCount*Shape)*Size` and alpha ramp `(1+levelIndex)/(LevelCount*(LevelCount+1))`; vertices stretched along Direction by `dot(v,Direction)*(StretchGrad-1)*atan(len(Grad)*StretchGradSquash)`, squashed by aspect, gradient-shaded (`Color + v.x*colorGradX + v.y*colorGradY`). GlistenCond: identical fan but gated `if (Intensity <= 0) return;` with atomic-compacted output (`atomic_fetch_add(outCounter)`) and intensity-scaled alpha.
- **Complexity:** Medium (three kernels: anchor search + two fan generators, each a single loop; no multi-frame sim).
- **Port interest:** Medium-High — coarse/fine anchor-finding plus gradient-shaded stretched fan generation is a distinctive image-reactive generative technique.
- **Parameters (22):** Color Grad Saturation, Smoothing, Flicker Sustain, Contrast, Color Grad Power, Color Grad Soft, Color Grad Mix, Color Grad Sharp, Blade Count, Flicker Release, Flicker Rate, Levels, Size, Gradation Shape, Stretch Grad Squash, Flicker Curve, Jitter, Stretch Grad, Stretch Y, Stretch X, Input Chaos, Input Alpha
- **Key expressions:** per-level scale `float scale = (LevelCount * Shape) / (levelIndex + (LevelCount * Shape)) * Size;`; stretch `v1 += dot(v1, Direction) * (StretchGrad - 1.0) * stretchGradPower;` where `stretchGradPower = atan(length(Grad) * StretchGradSquash)`. Graph ternary `cond ? a : b`.
- **Source:** `dnode/Products/Glisten.bundle` (+ kernels: Glisten.txt, GlistenCond.txt, GlistenFindAnchor.txt)

### LiftOrtho
- **What it does:** Spawns short-lived particle "petals/fans" across the frame that pop in and out, lifted into Z by a spherical/wave shape field — a 3D orthographic field of blooming sparkle fans whose depth, size and alpha pulse over each particle's life.
- **Technique:** Single GPU kernel; stateful particle pool with time recycling and LCG randomness (`index = (index+gid)*22695477+1`, `prandom[(index+gid) & 0xFFFFF]`). Each particle decrements `time -= StepSpeed`, respawns at a random screen pos + base angle on expiry, computes depth from a spherical shape field: `shapePos = magnitude_op(centeredPos*SphericalScale) + SphericalPhase`, `shapeCos = cos(shapePos*Pi)` giving zRange min/max; an animation envelope `animT = 1 - pow((2t-1)², AnimSquash)` blends Z (`Anim > Z`), scale (`Anim > Size`, `Z > Size`) and alpha (`atan(animT*AlphaSquash)/Pi*2`). A `StepCount` triangle fan is then swept by the fixed `AngleStep` complex rotation, squashed by 9:16 aspect, written as 3D positions `(pos, posZ, alpha)`.
- **Complexity:** Medium (single kernel; stateful lifetime recycling + shape-field Z-lift + fan generation, no inter-particle forces or trails).
- **Port interest:** Medium — depth shape-field plus animated particle-fan generator; more than routine but simpler than the trail/attractor sims.
- **Parameters (24):** Input Alpha, Hole Alpha, Dir Magnitude, Dir Angle, Spherical Scale, Spherical Phase, Rand > Poly Angle, Z > Size, Anim > Size, Spherical, Anim > Z, Anim Squash, Speed, Poly Angle, Poly Size, Alpha Squash, FOV, Dir X, Polygon, Count, Dir Y, Depth, Dir Z, Spherical Aspect
- **Key expressions:** anim envelope `animT = time * 2.0 - 1.0; animT = 1.0 - pow(animT * animT, AnimSquash);`; shape-field depth `float shapePos = magnitude_op(centeredPos * SphericalScale) + SphericalPhase; float shapeCos = cos(shapePos * Pi);`; respawn LCG `index = (index + gid) * 22695477 + 1;`.
- **Source:** `dnode/Products/LiftOrtho.bundle` (+ kernels: LiftOrtho.txt)

### LineCannon
- **What it does:** Fires animated line "tracers" that snake across the frame following ridges/gradients of an input image, each leaving a fading tail; tracers spawn at bright seed points, advance by momentum-damped gradient-following, recycle on a lifetime timer, and output colored Ponk line segments.
- **Technique:** Single stateful kernel (`LineCannonTrace.txt`), per-tracer ring buffer (`LineLength=512`, `MaxLines=32`). `time -= TimeDecay`; on death, gated by `atomic_fetch_add(outCounter[1]) < SpawnMoreCount`, picks the best of 3 random seeds by `brightness + pTemp*SamplingTemperature` (`SamplingTemperature=0.3`), seeds the ring with an initial gradient-descent direction (random fallback if gradient vanishes). Each frame advances `AdvSteps`: 4-tap image gradient → tangent (`float2(gradDir.y,-gradDir.x)`) blended `mix(mix(tangentDir,gradDir,GradientDescentFactor),dir,MomentumFactor)`, `NoGradRandomPower=0.03` perturbation when flat, appends to the ring `% LineLength`. Then emits the trailing `LineDrawLength` segments as Ponk pairs with alpha `(1 - (LineLength-i)/LineDrawLength) * pow(time,0.5)`, colored from `ColorTexture`.
- **Complexity:** High (single kernel, but a full multi-tracer ring-buffer path sim with spawn selection, image-gradient integration, and compacted fading line output).
- **Port interest:** High — image-following gradient-descent line tracers with momentum and trailing fade; distinctive attractor-style technique.
- **Parameters (12):** Speed, Spawn, Duration, Momentum, Color, Smoothing Mix, Speed Scale, Spawn Aux, L Render Alpha, Smoothing, Length, Input Alpha.
- **Key expressions:** tracer direction `mix(mix(tangentDir, gradDir, GradientDescentFactor), dir, MomentumFactor)`; trail alpha `(1.0 - (LineLength-i)/LineDrawLength) * pow(time, 0.5)`.
- **Source:** `dnode/Products/LineCannon.bundle` (+ kernels: LineCannonTrace.txt)

### LogisticRadial
- **What it does:** A radial/polar rendering of the logistic map — orbit values are emitted as particles with finite lifetime, jitter, spread and smoothing arranged around a center as spokes/rings rather than a flat bifurcation plot.
- **Technique:** Confirmed graph-only (no codegen kernel). 105 nodes: the same logistic recurrence `for (int i = 0; i < n; ++i) { x = r * x * (1 - x); } y = x;` (ExpressionNode) runs over `Threads`/`Particle Count` seeds via FillArray; orbit values are wrapped into radial coordinates by a large Math/ScalarCompute block (34 MathNode), latched into a particle buffer (LatchNode) with TimeToLive/Sink/Speed dynamics, Spread/Squash/Jitter/Sampling Width shaping placement; a ReadTexture-fed Vertex+Fragment pass draws Point Size points with Smoothing/Contrast/Threshold.
- **Complexity:** Medium.
- **Port interest:** High — attractor/bifurcation reinterpreted radially with particle lifetime.
- **Parameters (16):** r, Contrast, Smoothing, Sink, Jitter, Spread, Threshold, Squash, TimeToLive, n, Quality, Threads, Particle Count, Sampling Width, Speed, Point Size
- **Key expressions:** `for (int i = 0; i < n; ++i) { x = r * x * (1 - x); } y = x;`
- **Source:** `dnode/Products/LogisticRadial.bundle` (no kernel — graph-only; asset LogisticRadial)

### MadPoints
- **What it does:** Spawns a population of particles seeded onto dark regions of an input texture that fall under gravity while being sucked toward center, emitting two laser-line point streams — a continuous "light" stream of all live particles plus a sparser "power" stream of decaying-envelope flash particles.
- **Technique:** Two GPU passes. `MadPointsFindAnchor` reads a per-particle sampled UV and applies a 16:9 aspect remap (`x = (x-0.5)*16/9 + 0.5`) + vertical flip — almost all edge/gradient code is commented out, so it is a pass-through. `MadPointsSpawnSelect` is the stateful LCG particle simulator: respawn (`pRespawn < RespawnRate`) does `SamplingRetries` rejection-sampling tries against the texture biased by a `SamplingShape` vertical curve (`y = 1 - pow((1-y)^2, SamplingShape)`), keeping the *lowest*-luminance (darkest) spot; otherwise integrates `accel.y -= UpVelocity` (gravity), `dir = mix(accel + normalize(pos)*Sink, dir, Momentum)`, `pos += dir*Speed*2`. "Power" particles (`type==1`) decay an envelope `envelope -= EnvelopeDecayRate*DeltaTime` with random re-trigger, atomically appended to a capped `MaxPowerCount` buffer with intensity `time*pow(envelope, EnvelopeCurve)`; all live particles append to the light/laser stream.
- **Complexity:** Medium-High (2 kernels; genuine stateful per-particle physics with rejection sampling and atomic compaction into two streams).
- **Port interest:** High — distinctive image-seeded particle attractor sim with gravity/sink dynamics and envelope-driven flash selection.
- **Parameters (35):** G Stretch Grad, P Time to Live, P Sink, G Jitter, P Sampling Shape, G Smoothing, G Stretch Y, Input Alpha, G Stretch X, G Stretch Grad Squash, H Env Curve, H Env Rate, Input Expand, Input Hardness, P Alpha, H Alpha, H Rehighlight Rate, H Env Time, P Up Velocity, G Levels, G Size, P Point Size, G Color Grad Power, P Spawn Rate, G Gradation Shape, P Speed, H Max Count, G Blade Count, P Momentum, P Max Count, P Color B, P Color R, P Color G, H Highlight Rate, Debug Laser Alpha.
- **Key expressions:** velocity integration `dir = mix(accel + normalize(pos)*Sink, dir, Momentum)` with `accel.y -= UpVelocity`; sampling-shape bias `tryPos.y = 1 - pow((1-y)^2, SamplingShape)`; power intensity `time * pow(envelope, EnvelopeCurve)`. (Graph exprs are only generic `cond ? a : b` selects.)
- **Source:** `dnode/Products/MadPoints.bundle` (+ kernels: MadPointsFindAnchor.txt, MadPointsSpawnSelect.txt)

### MadScanner
- **What it does:** A trigger/rate-clock-driven "slash" beam generator (NOT a blob analyzer — the decoded kernel corrects the earlier guess). On a `Rate*DeltaTime` accumulator or external `Trigger` it grows an expanding horizontal arc-line, renders it as a tapered flaring flash-quad triangle fan plus a Ponk laser line pair that flickers as a laser, and emits a distortion field (center/direction/strength) for the companion distortion pass. Part of the Mad* laser family, essentially a MadShapes/MadSlasher sibling.
- **Technique:** Single stateful kernel (`MadScanner.txt`). Persists four counters on `outTriggerTime` (pretrigger, rate, triggered, flicker). `phaseTime = atan(rateTime*TimeSquash)/Pi*2` drives a growing line `lineY = mix(-SpawnSize, SpawnSize, phaseTime)`, width `sin(acos(1 - atan(phaseTime*ShapeSquash)/Pi*2)) * SpawnSize`. Laser-flicker duty cycle: `laserFlickerEnvContrib = mix(1, 1 - sin(saturate(triggeredTime)*Pi), LaserFlickerEnv)`, `flickerTime -= LaserFlickerRate*envContrib`, `isLaser = flickerTime > dutyFraction && (envContrib > LaserFlickerThreshold || ...)`. Builds a flash quad from arc endpoints + normal (`FlashQuadLength`, `FlashQuadFlare`) tessellated into `2*QuadHalfCount` (=20) UV-mapped triangles, plus laser endpoints into the Ponk stream colored from `ColorTexture`. Writes `outDistortionCenter / Direction (lineNormal) / Strength = mix(DistortionMin, DistortionMax, atan(pRand*5)...)`.
- **Complexity:** High (single dense kernel; procedural flash-quad geometry, growing-arc phase, laser-flicker state machine, distortion-field output).
- **Port interest:** High — solid trigger-driven flash/laser beam generator with flicker envelope and a distortion field hand-off; clean and self-contained.
- **Parameters (36):** Input Alpha, Flicker Threshold, Line Render Alpha, Input Smoothing, Env Decay Time, Env Curve, Env Rate Curve, Shape Squash, Time Squash, Noise Shape, Distortion Alpha, Value Squash, Env Gain, Flicker Hold Time, Level Select, Flicker Rate, Value Threshold, Env Rate, Debug Ponk, Env Constant, Flicker Env, Flash Alpha, Trigger, Spawn Size, Distortion Widen, Flash Brightness, Distortion Amount, Flash Smoothing, Flash Flare, Distortion Spray, Env Trigger, Rate, Env Decay Time, Flash Scale, TexIn Color Offset, Color Contrib.
- **Key expressions:** growing arc width `sin(acos(1 - atan(phaseTime*ShapeSquash)/Pi*2)) * SpawnSize`; phase `phaseTime = atan(rateTime*TimeSquash)/Pi*2`; flicker env `mix(1.0, 1 - sin(saturate(triggeredTime)*Pi), LaserFlickerEnv)`.
- **Source:** `dnode/Products/MadScanner.bundle` (+ kernels: MadScanner.txt)

### MadShapes
- **What it does:** On a rate-clock or external trigger, fires a randomly-placed/sized chord "slash" across the frame, rendered as a tapered flash-quad triangle fan (a beam flaring at the ends) plus a laser-line pair, fading via a decay envelope; also emits a distortion field (center/direction/strength) for a companion distortion pass.
- **Technique:** Two kernels. Stats (the active one): a `rateTime += Rate*DeltaTime` accumulator (or external `Trigger`) fires; on trigger an LCG `pGenerator*22695477+1` picks `arcStart` + `arcEnd = arcStart + mix(0.15,0.35,pArcLength)`, storing two endpoints on a `SpawnSize` circle; maintains a `triggeredTime` decay envelope (`-EnvDecay*DeltaTime`) + a laser-flicker duty cycle (`flickerTime -= LaserFlickerRate*laserFlickerEnvContrib`, `envFlickerOn = flickerTime > flickerDutyFraction && ...`); builds a 5-triangle flash quad from the endpoints + `lineNormal` with `FlashQuadLength`/`FlashQuadFlare` and UV mapping, writes Ponk laser endpoints colored from ColorTexture, and writes `DistortionCenter` (midpoint), `DistortionDirection` (lineNormal), `DistortionStrength` (triggeredTime). Lines is the near-identical sibling kernel (the other Mode/render variant). PonkOutputNode emits the laser path.
- **Complexity:** Medium (2 kernels; procedural geometry + trigger/envelope/flicker state, no texture-driven sim).
- **Port interest:** Medium — solid procedural triggered-beam/flash-quad generator with flicker and distortion output, but geometry/envelope driven rather than a novel sim.
- **Parameters (27):** Env Gain, Env Decay Time, Input Alpha, Env Rate, Env Constant, Mode, Debug Ponk, Env Trigger, Env Rate Curve, Input Smoothing, TexIn Color Offset, Debug Mask Alpha, Env Curve, Line Render Alpha, Value Squash, Flicker Hold Time, Shape Max Size, Flicker Rate, Shape Size Squash, Value Threshold, Level Select, Flicker Threshold, Flicker Env, Shape Scale, Momentum, Point Count, Color Contrib
- **Key expressions:** arc spawn `float arcEnd = arcStart + mix(0.15, 0.35, pArcLength);`; flash quad `flashQuad01 = flashQuad00 + lineNormal * FlashQuadLength - lineDir * flareLength;`; flicker gate `bool envFlickerOn = flickerTime > flickerDutyFraction && (laserFlickerEnvContrib > LaserFlickerThreshold || flickerTime > 1.0);`.
- **Source:** `dnode/Products/MadShapes.bundle` (+ kernels: MadShapesLines.txt, MadShapesStats.txt)

### MadSlasher
- **What it does:** A full-screen image displacement effect: warps/smears an input texture outward along a beam's normal, concentrated near a "slash" center line and modulated by a strength texture, producing a shattering/scatter distortion radiating from the slash — the visual partner to the MadShapes/MadScanner beams.
- **Technique:** The MadSlasher.txt kernel is the MadShapes-family beam generator (PCA-trigger + flash-quad + Ponk + distortion-field outputs: Center/Direction/Strength), and the actual displacement is the per-pixel MadSlasherDistortion.txt fragment pass. It decomposes the pixel relative to `DistortionCenter` into along-direction `offset` and along-normal `normalOffset`, samples `StrengthTexture` at a stretched UV gated to the leading side `saturate(1 - max(0,-offset*80)) * DistortionStrength`. A per-pixel hash LCG (`fract(sin(dot(gid_xy_norm, float2(12.9898, 78.233+poffset)))*43758.5453)` seeding `*22695477+1`) gives `pRandomStrength`, lateral `pRandomX`, and distance-squashed `pRandomY = pow(.,DistanceSquash)`; combined into `uvOffset = DistortionDirection*-strengthValue*pRandomY*scatterStrength + distortionNormal*-strengthValue*pRandomX*scatterStrength*sprayStrength`, with a distance-growing spray term, then samples textureInput at the displaced UV.
- **Complexity:** Medium (the beam kernel plus one fragment-style scatter-displacement kernel).
- **Port interest:** Medium — clean directional/strength-mask scatter-displacement shader; reusable but a fairly standard image-warp rather than a generative sim.
- **Parameters (33):** Input Alpha, Flicker Threshold, Line Render Alpha, Input Smoothing, Env Curve, Env Decay Time, Env Rate Curve, TexIn Color Offset, Color Contrib, Distortion Alpha, Value Squash, Env Gain, Flicker Hold Time, Level Select, Flicker Rate, Value Threshold, Env Rate, Debug Ponk, Env Constant, Flicker Env, Flash Alpha, Pretrigger, Spawn Size, Flash Smoothing, Flash Brightness, Distortion Widen, Distortion Spray, Distortion Amount, Env Trigger, Rate, Flash Scale, Flash Flare, Env Decay Time
- **Key expressions:** per-pixel hash `fract(sin(dot(gid_xy_norm, float2(12.9898, 78.233 + poffset))) * 43758.5453)`; scatter offset `float2 uvOffset = DistortionDirection * -strengthValue * pRandomY * scatterStrength + distortionNormal * -strengthValue * pRandomX * scatterStrength * sprayStrength;`; leading-side gate `strengthValue = saturate(strengthValue * 4) * saturate((1 - max(0.0, -offset * 80))) * DistortionStrength;`.
- **Source:** `dnode/Products/MadSlasher.bundle` (+ kernels: MadSlasher.txt, MadSlasherDistortion.txt)

### MadTracer
- **What it does:** A laser "tracer" that walks segmented strokes through a grid/phase, quantizing a path into a tunable number of segments with hardness/threshold gating and temporal smoothing, drawing connected laser line segments — part of the Mad* laser family.
- **Technique:** Graph-only (no generated kernel; 128 nodes, 4 literals). A ScalarCompute (16)/Math (35) chain plus 5 ExpressionNodes (none named/captured) generates path points from a `Phase`-driven walk, quantizes the stroke into `Segments` (with `Quantize Segments`, `Segments Squash`, `Segment Length`/`Alpha`), gates on `Threshold`/`Hardness`, and applies `Smoothing` + `Temporal Smoothing`. Output feeds a Vertex+Fragment renderer (2 each) and a PonkOutputNode (laser). 9 TextureComputeNodes back the intermediate buffers; Debug Input/Mask Alpha and Input/Line Alpha expose the layers.
- **Complexity:** Medium-High (128 nodes; segmented phase-walk path generation + laser output, no compute kernel).
- **Port interest:** High — generative segmented laser path tracer with Ponk output; self-contained.
- **Parameters (14):** Hardness, Threshold, Quantize Segments, Segments, Smoothing, Debug Input Alpha, Segments Squash, Debug Mask Alpha, Phase, Segment Alpha, Segment Length, Input Alpha, Line Alpha, Temporal Smoothing
- **Source:** `dnode/Products/MadTracer.bundle` (no kernel — graph-only; asset MadTracer.asset)

### MadZoomer
- **What it does:** A laser/projection "frame zoomer" tied to a triangle: it traces the triangle outline as a laser, flashes, then repeatedly zooms the triangle's textured contents inward in stepped pulses before holding and releasing — a strobing, zooming triangle drawing both a Ponk laser outline and a texture-mapped triangle (Tri) with tint flashes.
- **Technique:** Single compute kernel running a stateful 6-phase state machine (Trace→Flash→FlashPause→Zoom→Hold→Release) persisted across frames in `outTriggerTime` slots (phaseTime/phase/triggeredTime/flickerTime + a TraceStart seed). Trace walks the triangle perimeter by arc-length (`TraceLength = pow(phaseTime, TracePhaseCurve)`) emitting Ponk laser points; Flash tints `float4(float3(1), 1 - pow(phaseTime, FlashPhaseCurve))`; Zoom steps `D Zoom Steps` cycles with a duty cycle (`isDuty`), `contentsZoom = 1 + pow(saturate(cycles/Steps), ZoomEasing) * MaxZoom` and a black off-alpha; Hold pins max zoom; Release cycles laser/contents off (`F Release Laser/Image Cycle`). LCG RNG (`*22695477+1`) seeds the trace start; an envelope/flicker duty gates the laser (same `envFlickerOn` logic as MadShapes); atomic counters append Ponk path points + colors from ColorTexture and a textured triangle with UV recomputed per `contentsZoom` about the centroid.
- **Complexity:** Medium (single but dense kernel: a large stateful phase machine with dual output paths — Ponk laser + Tri texture).
- **Port interest:** Medium — self-contained and clean, but the value is the phased trace/flash/zoom/release choreography rather than novel math.
- **Parameters (39):** Value Threshold, Env Constant, Env Rate, Debug Ponk, Flicker Hold Time, Level Select, Env Trigger, TexIn Color Offset, Color Contrib, Env Decay Time, Rate, View Alpha, Flicker Rate, Flicker Env, Input Smoothing, Env Curve, Env Decay Time, Input Alpha, Flicker Threshold, Line Render Alpha, Env Gain, Value Squash, Distortion Alpha, Env Rate Curve, A Trace Curve, B Flash Curve, F Release Time Scale, A Trace Time Scale, B Flash Time Scale, F Release Image Cycle, F Release Laser Cycle, E Hold Time Scale, D Zoom Off Alpha, D Zoom Curve, D Zoom Duty, D Zoom Zoom, D Zoom Steps, D Zoom Time Scale, C Pause Time Scale
- **Key expressions:** stepped zoom `contentsZoom = 1 + pow(saturate(((float)cycles) / ZoomPhaseSteps), ZoomPhaseEasing) * ZoomPhaseMaxZoom;`; trace length `float TraceLength = pow(phaseTime, TracePhaseCurve);`; flash tint `contentsTintColor = float4(float3(1), saturate(1 - pow(phaseTime, FlashPhaseCurve)));`.
- **Source:** `dnode/Products/MadZoomer.bundle` (+ kernels: MadZoomer.txt)

### PetriDish
- **What it does:** An organic "petri dish" particle sim with two populations — many "Small" cells and a few "Big" attractor cells — that drift with momentum and an "undertow", sink toward center, are deformed by a custom polynomial vector field, repelled by a soft circular boundary, and optionally pulled toward the input image; drawn as soft line-rendered blobs with finite lifetimes. CONFIRMED graph-only.
- **Technique:** No generated kernel — built-in nodes (328 total: 122 Math, 49 value inputs, 28 Pack / 21 Unpack, 16 ScalarCompute, 15 ReadTexture, 7 TextureCompute, Vertex/Fragment line passes, no PonkOutput — line-rendered, not laser). Each particle integrates the embedded `Field Expr` 2D velocity field (skewed/squashed by `Field Skew`/`Field Squash`, scaled by `Field Scale`/`Field Speed`), with `Momentum`/`Momentum Decay`, `Sink`, `Undertow Skew/Squash`, and a `Boundary` (`Boundary Size/Speed/Stiffness`, `Big Boundary Shrink`). The "Big" set has its own curl/spread/repel dynamics (`Big Curl(Direction)`, `Big Spread(Jitter)`, `Big Repel Speed`, `Big Direction`); "Small" cells can convert toward Big (`Small To Big`). `To Image`/`To Image Curl` pull particles toward the texture. Lifetime via `TimeToLive`/`BigTimeToLive`; rendered as `Line Count` blobs with `Line Rate`/`Line Alpha`. Spawn select uses `cond ? b : a`.
- **Complexity:** High (328 nodes / ~122 Math; dual-population field-integrator sim, no kernel).
- **Port interest:** High — living/organic dual-population particle simulation with a hand-authored vector field and boundary physics; this same P-field is reused inside DoubleChamber.
- **Parameters (49):** Boundary Speed, Small Curl, Line Rate, To Image, Image Scale, Small Spawn Size, Debug Image View, Small Jitter, Field Scale, Line Count, Image Smooth Balance, Small To Big, Line Alpha, Image Subsmoothing, Field Speed, Particle Count, Big Speed, Debug View, TimeToLive, Big Boundary Shrink, Big Direction, Big Repel Speed, Undertow Skew, To Image Curl, Big Curl Direction, Big Point Size, Image Smoothing, Small Squash, Small Curl Direction, Sink, Boundary Stiffness, Big Momentum Decay, BigTimeToLive, Momentum, Big Count, Point Size, Big Sink, Big Curl, Field Squash, Big Spread, Momentum Decay, Big Spread Jitter, To Image Curl Direction, Field Skew, Boundary Size, Undertow Squash, Z Depth, Big Momentum, Small Boundary.
- **Key expressions:** the particle velocity field `float2((x.y*x.y - 1.0 - (x.x*skew*-0.6 + skew*0.1)), (x.x + skew*0.7) * sign(x.y) * pow(abs(x.y) + 0.7 + squash*0.8, 3) * -0.1 * squash)`; spawn select `cond ? b : a`.
- **Source:** `dnode/Products/PetriDish.bundle` (no kernel — graph-only)

### PetriDish2
- **What it does:** A second iteration/variant of PetriDish. The bundle has no recoverable `.asset` (orphan, null key in the decoded set), so specifics are unconfirmed; by family it is the same organic dual-population "dish" particle sim — likely revised counts, field tuning, or colony/shape behavior.
- **Technique:** Inferred identical to PetriDish — built-in-node dual-population field integrator (the polynomial `Field Expr` velocity field, momentum/undertow/sink, soft circular boundary, Big/Small populations) with soft line rendering; no generated kernel.
- **Complexity:** High (assumed, mirroring PetriDish's ~328-node graph).
- **Port interest:** High (assumed) — organic particle sim; verify against a recovered asset before committing, since none is present in the tree.
- **Parameters (N):** None recoverable (no asset/graph decoded). Assume the PetriDish control surface (49 params: Field Scale/Speed/Skew/Squash, Momentum/Sink/Undertow, Boundary Size/Speed/Stiffness, Big/Small population controls, To Image, TimeToLive, Line/Point rendering) as the baseline.
- **Key expressions:** inferred same velocity field as PetriDish — `float2((x.y*x.y - 1.0 - (x.x*skew*-0.6 + skew*0.1)), (x.x + skew*0.7) * sign(x.y) * pow(abs(x.y) + 0.7 + squash*0.8, 3) * -0.1 * squash)`.
- **Source:** `dnode/Products/PetriDish2.bundle` (no kernel, no asset — unrecoverable variant of PetriDish)

### QuadRevolver
- **What it does:** Revolves four live-video inputs around a center, cycling which input occupies each quad position via add/subtract counters with momentum and an envelope-driven decay — a kaleidoscopic four-way rotating video layout.
- **Technique:** Confirmed graph-only (no codegen kernel). 65 nodes: 4 NioTextureInput sources, 5 LatchNode state holders driving Add/Sub position counters (Add/Sub In, Floor, Momentum, Power) with Linear Decay + Env Curve, two ExpressionNodes — a power-shaped envelope `In > 0 ? (1.0f + In * Power) : (1.0f + In)` and a wrap-around index selector `In <= 0 ? 0 : (((In - 1 + Offset) % Count) + 1)` — feeding a Mix/Switch/Route block into a single TextureCompute. Per-input Tex1..4 In Offset rotate which source maps where; Rotate Ins toggles the cycling.
- **Complexity:** Low-Medium (~25 Math nodes).
- **Port interest:** Low-Medium — multi-input video transform/compositor, input-driven not generative.
- **Parameters (21):** Tex1 In Offset, Tex2 In Offset, Tex3 In Offset, Tex4 In Offset, Add Floor, Add2 In, Sub2 Floor, Add2 Floor, Add Momentum, Sub In, Sub Floor, Sub2 In, Add In, Sub Momentum, Env Curve, Linear Decay, Add Power, Add2 Power, Sub Power, Sub2 Power, Rotate Ins
- **Key expressions:** `In > 0 ? (1.0f + In * Power) : (1.0f + In)`; index wrap `In <= 0 ? 0 : (((In - 1 + Offset) % Count) + 1)`
- **Source:** `dnode/Products/QuadRevolver.bundle` (no kernel — graph-only; asset QuadRevolver)

### QuadRevolver2
- **What it does:** A greatly expanded QuadRevolver — the four rotating video quads gain per-input stutter (rate-gated frame holds), per-input curve and range-begin/end remaps, a threshold-with-cooldown trigger that randomizes rotation, and randomized hold timing — turning the layout into a glitchy, beat/threshold-reactive video switcher.
- **Technique:** Confirmed graph-only (no codegen kernel). 193 nodes (102 MathNode): 4 NioTextureInput sources, 8 LatchNode state holders, 4 GenerateValue rails, a ReadBufferRef + TextureInput feedback path, and a Threshold/Threshold Cooldown gate with Random Min/Max Time + Random Power randomizing rotation. Same envelope expression `In > 0 ? (1.0f + In * Power) : (1.0f + In)` plus the float wrap variant `In <= 0 ? 0 : (fmod((In - 1 + Offset), Count) + 1)`; per-input In1..4 Stutter/Stutter Speed/Curve/Range Begin/Range End controls, all collapsed into one TextureCompute.
- **Complexity:** Medium (largest graph-only entry here at 49 params).
- **Port interest:** Low-Medium — elaborated glitch/threshold-reactive video compositor, still input-driven not generative.
- **Parameters (49):** In1 Stutter Speed, In1 Stutter, In2 Stutter, Threshold In, Threshold Cooldown, Debug Ins, Add Power, Threshold, In3 Range Begin, In3 Stutter, In2 Range Begin, In2 Stutter Speed, In1 Curve, In2 Curve, In3 Curve, In4 Curve, In4 Stutter, In3 Stutter Speed, Sub In, In2 Range End, In3 Range End, In4 Range Begin, In4 Range End, In4 Stutter Speed, Rotate Ins, Tex2 In Offset, Sub2 In, Random Power, Tex1 In Offset, Add In, Env Curve, Sub2 Power, Tex3 In Offset, Sub Power, In1 Range End, Add2 In, Add Floor, Tex4 In Offset, In1 Range Begin, Decay Time, Add Momentum, Add2 Floor, Sub Momentum, Add2 Power, Sub2 Floor, Random Max Time, Random Min Time, Sub Floor, Passthrough Alpha
- **Key expressions:** `In > 0 ? (1.0f + In * Power) : (1.0f + In)`; index wrap `In <= 0 ? 0 : (fmod((In - 1 + Offset), Count) + 1)`
- **Source:** `dnode/Products/QuadRevolver2.bundle` (no kernel — graph-only; asset QuadRevolver2)

### Scribbler
- **What it does:** A "scribble" line-draw filter over an input image — traces short strokes whose direction/length follow the image gradient, producing a hand-sketched/etched look, with sink, jitter and smoothing controls.
- **Technique:** Confirmed graph-only (no codegen kernel). 100 nodes: 10 ReadTextureNode taps (multi-sample gradient/luminance probing) feed a 40-node Math block + 11 PackNode / 10 UnpackNode that build per-stroke line geometry over a FillArray of `Count` strokes; the Gradient param weights edge-following, Distance/Sink/Jitter shape stroke length and wander, Smoothing/Quality temper the result; a TypeDecl-defined struct rail drives a Vertex+Fragment pass to draw the strokes.
- **Complexity:** Medium (~40 Math nodes, 10 ReadTexture taps).
- **Port interest:** Medium — stylized image-driven gradient-following line renderer, but input-bound.
- **Parameters (7):** Count, Gradient, Jitter, Quality, Distance, Smoothing, Sink
- **Source:** `dnode/Products/Scribbler.bundle` (no kernel — graph-only; asset Scribbler)

### SPHR BicolorGrad
- **What it does:** Spherical/dome sibling of BicolorGrad: analyzes an equirectangular image to extract two dominant hues, locates where each color sits as a 3D "pole" on the sphere, and renders a smooth spherical bicolor gradient that blends between the two hues across the dome with a tunable neutral mid-band and hue-step banding.
- **Technique:** Three passes (all share the Quat + spherical lib; `ToHSL` RGB→YIQ→hue/chroma ExpressionNode feeds the histogram). (1) FindColors: scans a 64-bucket hue histogram (`BucketCount=64`), picks the major peak with parabolic sub-bucket interp `(w2-w0)/w1*0.5 + bestBucket`, then a minor peak weighted by a squared isolation falloff `saturate(abs(i-majorBucket)/BucketCount/IsolationWidth)²` (IsolationWidth 0.3); derives an `offBucket`, confidence weights via `atan(weight*ColorSaturate)`, and blends both hues toward `NeutralHue` by confidence (`MajorHue += Wrap05(NeutralHue-MajorHue)*(1-alpha)`). (2) LocateColors: a 4x4 `SuperGridSize` over a 16-texel HSL image, `Q::SampleRegion` accumulates weighted UV centroids of major (`x*z`) and minor (`y*z`) color mass per region; strongest major/minor regions' centroids become `MajorPole = UVToSpherical(maxCenter)*majorWeight`, `MinorPole = UVToSpherical(minCenter)*minorWeight`. (3) RenderPoles: per pixel `spos = UVToSpherical(uv)`, `balance = clamp(tanh((dot(spos,major) - dot(spos,minor) + MajorBias)*Scale) + ..., -1,1)`; a foldback mid-band `1 - Foldback01(clamp(balance*MidWidth,...))` shaped by `MidCurve`, hue stepping `sin(hueStepDelta*atan(...))`, hue interp toward minor by `minorHueT` with reversal desaturation, then `HslToRgb`.
- **Complexity:** High (three chained passes: histogram peak-pick → spherical pole location → per-pixel spherical render, with substantial color-science + sphere math).
- **Port interest:** High — content-adaptive two-color spherical-gradient generator; distinctive and reusable for dome/360 backdrops.
- **Parameters (17):** Neutral Hue, Pole Normalize, Hue Step Curve, Neutral Range, Hue Step, Major Bias, Scale, Reverse, Hue Step Normalize, Temporal Smoothing, Mid Curve, Mid Saturation, Mid Brightness, Neutral Saturation, Mid Width, Hue Step Mix, Neutral Brightness
- **Key expressions:** ToHSL: `float hue = abs(I) <= (1.0/(256*256)) ? 0.0 : atan2(Q, I); float chroma = sqrt(I*I + Q*Q); hue /= Pi*2; hue -= floor(hue); Out = float4(hue, chroma, YPrime, In.a);`; histogram atomic splat `atomic_fetch_add_explicit(&(output0[(int)round(Index)]), (int)round(16 * Amount), memory_order_relaxed);`; balance `clamp(tanh((rawBalance + MajorBias) * Scale) + MajorBias * 0.01, -1.0, 1.0)`.
- **Source:** `dnode/Products/SPHR BicolorGrad.bundle` (+ kernels: "SPHR BicolorGradFindColors.txt", "SPHR BicolorGradLocateColors.txt", "SPHR BicolorGradRenderPoles.txt")

### SPHR Magneto Dynamics
- **Name:** The intended name is **Magneto**; the shipped bundle/asset files are misspelled "Magento" (the `.txt` kernels and the graph `title` already use "Magneto"). Use **Magneto** for the port.
- **What it does:** Particles flow through a magnetic-dipole vector field on a sphere — two poles (Pole+, Pole-) emit curl + divergence that push particles along field lines, blended with image-gradient steering and an "undertow", rendered as TWO independent systems: a soft point/particle render ("P") and a trailing line render ("L"), for a dome/360 magnetic-field dynamics look.
- **Technique:** Graph-only (no generated kernel; 239 nodes, 62 value inputs). A ScalarCompute (50)/Math (52) field integrator evaluates a curl/divergence field around `Pole+ Pitch/Yaw` and `Pole- Pitch/Yaw` about `Curl Axis Pitch/Yaw` (Curl Strength, Pole Strength, Pole Curl, Pole Divergence, Grad Curl, Grad Descent, Grad Mix), with Momentum/ZMomentum integration, Undertow + Respawn Rate recycling, and an image gradient search (Img Search/Grad Sweep+Intensity, Grad H Distance, Search Temperature, Img Smoothing). Two FillArrayNodes seed two particle pools; the duplicated `P …`/`L …` param banks drive two separate renderers (2 VertexShaderCompute + 2 FragmentShaderCompute), the L bank adding line Length/Advance/Adv Momentum and a Value Threshold/Decay envelope. Debug Grad/Search expose the raw fields.
- **Complexity:** High (239 nodes; dual-pool field integrator with two-pole curl/divergence + image-gradient coupling + two render pipelines).
- **Port interest:** High — distinctive curl/divergence magnetic-dipole particle dynamics on a sphere with image steering, confirmed as a true dual-system (points + lines) effect.
- **Parameters (62):** P Grad FB Smoothing, P Render Alpha, P Step Speed, P Time Scale, P Search Temperature, P Grad Curl, P Curl Strength, Img Search Sweep, Img Search Intensity, P Pole Strength, P Spawn Line, P Grad Mix, L R ZThreshold, P R ZThreshold, P R Size, P Momentum, P Pole Curl, P Pole Divergence, P Grad Descent, P Respawn Rate, P Time Duration, P R Color Contrib, P Count, P R Soft, L Pole Curl, L Pole Divergence, Grad H Distance, L Grad Descent, L Momentum, L Time Duration, Img Grad Sweep, L Respawn Rate, L Pole Strength, L Step Speed, L Length, L Advance, L Time Scale, L Search Temperature, L Grad Curl, Img Smoothing, L Curl Strength, Pole+ Yaw, Debug Grad, Img Grad Intensity, L Render Alpha, L Adv Momentum, L R Color Contrib, Pole+ Pitch, L Count, Curl Axis Pitch, Curl Axis Yaw, L R Soft, Pole- Pitch, Pole- Yaw, L ZMomentum, L Undertow, P ZMomentum, P Undertow, P FB Contrast, Debug Search, L Value Threshold, L Value Decay
- **Source:** `dnode/Products/SPHR Magento Dynamics.bundle` (no kernel — graph-only; asset "SPHR Magento Dynamics.asset")

### SPHR Rand Billboard
- **What it does:** Scatters a field of randomized textured quad "billboards" over an equirectangular sphere/dome — each is a 4x4-subdivided plane oriented by composite quaternion rotations (base + splay fan + per-instance jitter), with per-instance angle/skew/splay/alpha/motion-phase randomness, correctly clipped and seam-wrapped across the z=0 plane and the equirectangular x-seam.
- **Technique:** Two passes sharing the full Quat + spherical projection library (`F::ProjToUV` = equirect projection, `F::Foldback01`, `F::Mantissa01`; LCG `Random` class). GenTri: per instance an envelope `env = 1 - Wrap01(proffsetPreFine + pindexFine)` drives `angle = Angle * mix(1,pAngle,SizeJitter) * 2PI * mix(1, pow(env,PlaneSizeEnvCurve), -PlaneSizeEnv)`; a `splayT` fans instances via `splayRotationDir = (cos(SplayAngle·2PI), sin(SplayAngle·2PI), SplayRoll·2PI)`; a 4x4 grid of quads is offset on a `forward={0,0,-1}` vector with `Projection` secant-warp + skew + jitter, oriented through `Q::Soffset` (Y·X·Z quaternion compose), then `Tribuf::Write` clips each triangle: if the pole is inside it emits one tri, else it detects `sign(ps[i].z)` straddling, splices new vertices at the z-plane (`proj = 1 - p1.z/delta.z`) and emits the spliced fragments for x-wrap biases −1/0/+1 (`uvs.x -= round(uvs.x*0.5)*2 - bias`); BUFFER_LENGTH 384, flushed via an atomic counter. Vertex: re-reads each emitted tri, re-detects z-straddling and atomically appends additional spliced/wrapped copies (`newTriCount = 2*3+2`), writing final `ProjToUV` UVs.
- **Complexity:** High (two passes; per-instance quaternion orientation + nontrivial z-plane/equirect-seam clipping geometry amplification with atomic emission).
- **Port interest:** High — the equirect seam + z-plane triangle splicing/wrapping is tricky and reusable; the splay/jitter quaternion billboard system is a strong dome building block.
- **Parameters (28):** Center Roll, Plane Size, Center Yaw, Size Jitter, Center Pitch, Motion Manual, Count, Splay Roll, Splay Angle, Splay Distance, Jitter, Motion Phase Align, Jitter X, Jitter Y, Jitter Z, Projection, Plane Skew H, Plane Skew W, Skew W Jitter, Skew H Jitter, Alpha Jitter, Alpha < Env, Splay < Env, TimeScale, Splay < Env Curve, Alpha < Env Curve, Plane Size < Env Curve, Plane Size < Env
- **Key expressions:** envelope `1.0 - F::Wrap01(proffsetPreFine + pindexFine)`; z-plane splice `float proj = (1 - (p1.z / delta.z)); spliceap = p0 + delta * proj;`; seam-wrap `uvs[0].x -= round(uvs[0].x * 0.5) * 2.0 - newuvBias.x;`. Graph also carries a ternary `c ? a : b` and a fold `(x < 0 ? (x + 1.0f) : ((x+1) * 4))`.
- **Usage (team):** Easy way to fill a spherical display, but **very buggy — has visual artifacts**; the seam/z-plane clipping is the likely culprit and should be fixed on port.
- **Source:** `dnode/Products/SPHR Rand Billboard.bundle` (+ kernels: "SPHR Rand Billboard GenTri.txt", "SPHR Rand Billboard Vertex.txt")

---

## Orphan NanoGraph assets (built but not in Products/)

- **AudioAnalysis** — audio feature-extraction graph (FFT/envelope/band analysis) used as an upstream input source for the audio-reactive effects, not a standalone visual.
- **BlurProto** — a prototype/utility blur pass (likely separable Gaussian or downsample-blur), reusable image filter rather than a shipped effect.
- **SPHR Tokamak** — a spherical/dome physics-style effect (Tokamak = toroidal magnetic-confinement plasma); presumably a torus/plasma-field particle sim in the SPHR family, unfinished or unshipped.
- **TrigridRedux** — a triangular-grid generative/geometry effect (a "redux" rework of an earlier trigrid), likely a tessellated grid pattern generator.
- **Test / Test 1 / Test 2 / Test 3 / subtest1** — test/scratch graphs, not effects; skip.

---

# Wire — Patch Catalogue

104 patches from Resolume Wire. Custom ISF shaders are named in each entry's Technique line; node counts indicate graph complexity. Listed alphabetically.

### 3 Slice
- **What it does:** Splits the source into N (≈3) vertical slices repeated across the frame, then carves each slice's height into a bottom band, a middle band, and a top band whose mid-section size is scaled per-slice and animated, with a perspective-like horizontal skew.
- **Technique:** Custom ISF `Slices` shader — `floor`-based horizontal repeat indexing reads a per-slice scale from a 1px array texture (`To Texture`), remaps Y into three weighted bands (top/mid/bottom) and applies a top/bottom-anchored U skew; driven by Metronome-gated Random + Smooth for the per-slice values; Cross Fader / Wave / Sine for animation.
- **Complexity:** Medium — 50 nodes / 60 conns.
- **Port interest:** Distinctive band-remap + per-slice array-LUT sampling; a good compute-shader candidate (the array texture becomes a small SSBO).
- **Source:** `Wire/Patches/3 Slice`

### 3D Chen Attractor
- **What it does:** A generative source that integrates the Chen strange attractor in 3D, rendering the evolving point/trajectory as projected shapes with yaw/pitch/roll camera control, spawn radius, time-to-live respawning and reset.
- **Technique:** Explicit Euler integration of the Chen equations laid out as discrete nodes (`a(y-x)`, `(c-a)x - xz + cy`, `xy - bz`) with `Delay`/`Snapshot` feedback as the state register; dt/Time-Scale stepping; 3x3 basis (X/Y/Z basis, Sin/Cos, Pi) rotation matrix; Time-to-Live + Modulo + Trigger for particle respawn; `Shape Render` to texture.
- **Complexity:** High — 151 nodes / 194 conns.
- **Port interest:** Very compelling — a hand-wired ODE integrator with feedback state; ideal to collapse into a single compute-shader particle/attractor kernel.
- **Source:** `Wire/Patches/3D Chen Attractor`

### 4x1 Gen LogisticMap
- **What it does:** Generative effect that iterates the logistic map x→Rx(1-x) several times per frame and turns the chaotic values into a colored, motion-blurred banded texture mixed over the input.
- **Technique:** Unrolled logistic-map iterations (`Multiply`, `1 - x`, `R`) feeding a `Gradient` color LUT; Saw/Metronome/Attack-Release timing; `Motion Blur` + `Long Tail` feedback trails; `Video Mixer` composite with Invert/Complimentary color ops.
- **Complexity:** Medium — 69 nodes / 91 conns.
- **Port interest:** Compelling — chaotic-map → gradient-LUT is a clean compute kernel; trails map to a feedback buffer.
- **Source:** `Wire/Patches/4x1 Gen LogisticMap`

### 4x1 Gen ShapeBurst
- **What it does:** A 4-lane ("4x1") generator that bursts transformed shapes (rectangles/lines) outward from a center on metronome triggers, with randomized rotation/line-weight/position per burst, slice alpha control and gradient coloring composited over the input.
- **Technique:** Heavy use of `Read`/`Write` + `Index`/`Equal` as an addressable per-slice register bank; Random + Curve + Cross Fader for per-burst params; Metronome/Trigger Now/Squelch gating; `Transform` + `Shape Render` (Rectangle/Edge) drawing; Color Start→End interpolation; `Long Tail` trails.
- **Complexity:** High — 172 nodes / 221 conns.
- **Port interest:** Compelling but sprawling — the register-bank-as-particles pattern is the interesting part; would become an instanced-shape compute pass.
- **Source:** `Wire/Patches/4x1 Gen ShapeBurst`

### 4x1 Rotate
- **What it does:** Divides the frame into 4 horizontal strips/quadrants and rotates each independently by its own per-strip rotation amount.
- **Technique:** 4 parallel `Transform`(rotate) + `Crop` chains, each fed a rotation value, recombined via `Merge`; `Dimension`/`Unpack`/`Round`/`Divide` compute crop rects.
- **Complexity:** Low — 34 nodes / 40 conns.
- **Port interest:** Trivial utility (per-tile affine transform); not distinctive on its own.
- **Source:** `Wire/Patches/4x1 Rotate`

### Alpha 50
- **What it does:** A minimal video mixer that blends two inputs at a fixed/opacity-controlled mix (50%).
- **Technique:** Two `Texture In` → `Map` → `Video Mixer` with an `Opacity` control. Boilerplate mixer.
- **Complexity:** Low — 7 nodes / 7 conns.
- **Port interest:** Trivial utility (standard alpha blend); skip.
- **Source:** `Wire/Patches/Alpha 50`

### Alpha Modulate
- **What it does:** Reshapes the input's alpha channel via a gamma/power curve so existing transparency can be pushed harder or softer, scaled by opacity.
- **Technique:** Custom ISF `Alpha Curve` shader — `a = pow(a, power)` then `mix(orig, curved, opacity)`; `Curve`/`Add`/`Negate` drive the power input.
- **Complexity:** Low — 7 nodes / 6 conns.
- **Port interest:** Trivial utility (alpha gamma); a one-line shader.
- **Source:** `Wire/Patches/Alpha Modulate`

### Alpha Modulate 2
- **What it does:** Like Alpha Modulate but a pure node-graph (no ISF) alpha remap with a power curve, thresholded switch and clamp.
- **Technique:** `Power` + `Curve` + `1/x` + `Greater`/`Switch` + `Clamp`/`Map` operating on the alpha; no shader.
- **Complexity:** Low — 12 nodes / 13 conns.
- **Port interest:** Trivial utility; skip.
- **Source:** `Wire/Patches/Alpha Modulate 2`

### Anim Grid
- **What it does:** Tiles the input into an animated grid of cells; cells are triggered (per metronome cycle, with per-lane probability) to play short motion bursts/force pushes, with soft edges, vignette and bias controls for grid placement.
- **Technique:** Counter/Modulo/On-Change cell addressing with `Snapshot` latches; 4 lanes of Cycles/Frame-Time/Force/Probability driven by Metronome + Random + Not; `Transform`/`Crop`/`Resize` per cell; `Edge Soft` + `Vignette`; `Video Mixer` composite.
- **Complexity:** High — 134 nodes / 159 conns.
- **Port interest:** Compelling — grid-cell scheduler with per-cell state; maps well to a per-tile compute dispatch.
- **Source:** `Wire/Patches/Anim Grid`

### Apply Alpha
- **What it does:** Reapplies/premultiplies the input's own alpha channel onto the color.
- **Technique:** `Alpha` → `Replace Alpha` → `Premultiply Alpha`. Pure utility.
- **Complexity:** Low — 5 nodes / 4 conns.
- **Port interest:** Trivial utility; skip.
- **Source:** `Wire/Patches/Apply Alpha`

### BandPassGlow
- **What it does:** Isolates a moving hue/luma "band" of the image (a band-pass around an animated center) and makes it glow, with a rippling displaced mask, temporal smoothing and a boosted overlay composited back.
- **Technique:** Band-center + band-width windowing via `Map`/`Clamp`/`Subtract`/`Absolute` on color channels; `Ripple` + `Displace` + `Mask` for the animated mask (Saw/Sin/Cos/Modulo driven); `Delay` temporal smoothing; multiple `Video Mixer` glow composites; Greyscale/Saturation/Bright.Contrast grading.
- **Complexity:** High — 116 nodes / 149 conns.
- **Port interest:** Compelling — band-pass-keyed glow + rippling mask displacement is a rich multi-pass effect worth porting.
- **Source:** `Wire/Patches/BandPassGlow`

### BeatSwitcher
- **What it does:** A beat-synced mixer that cuts/crossfades between sources on a configurable beat cycle, shaped by a tunable beat envelope (attack/release, bounce, smoothing) and optionally driven by live audio.
- **Technique:** Metronome + Counter/Modulo + On-Change + Random for switch scheduling; `Cross Fader` + multiple `Video Mixer`; `Attack Release` + Curve + Smooth beat envelope; Audio IN / Max BPM / Sensitivity for audio-reactive triggering; Toggle/Cut/Switch-Now manual overrides.
- **Complexity:** High — 99 nodes / 117 conns.
- **Port interest:** Compelling as a control-rig (beat scheduling + envelope shaping); the visual op is just a crossfade — port the timing logic.
- **Source:** `Wire/Patches/BeatSwitcher`

### BeatSyncTest
- **What it does:** A diagnostic source that renders a beat grid — 8 on-beat / off-beat ("1, 1&, 2, 2&…") indicator cells that pulse with an envelope on each transport beat, scaling/coloring per step.
- **Technique:** Transport Beat → Modulo/Floor/Int step index; per-step Bool toggles (1s/1&s…) + Equal/On-Change; `Attack Release` envelope; `Shape Render` (Rectangle) with Transform scale and Saturation; Min/Max scale + Env Amount controls.
- **Complexity:** Medium/High — 73 nodes / 81 conns.
- **Port interest:** Mostly a test harness; the beat-grid step decode is reusable but the visual is trivial.
- **Source:** `Wire/Patches/BeatSyncTest`

### Bright.Contrast Env
- **What it does:** Applies a brightness/contrast pop that is triggered and shaped by an envelope (attack/release over a Time), e.g. a beat-driven flash.
- **Technique:** `Trigger`/`TriggerF`/`On-Change` fire an `Attack Release` envelope (Min/Max, Time) → mapped through `Curve` into the `Bright.Contrast` amount.
- **Complexity:** Low — 19 nodes / 20 conns.
- **Port interest:** Trivial utility (enveloped color grade); skip.
- **Source:** `Wire/Patches/Bright.Contrast Env`

### Bright.Contrast Smooth
- **What it does:** Brightness/contrast adjustment whose control values are temporally smoothed (eased) over a Duration to avoid hard jumps.
- **Technique:** Two `Smooth` nodes (Duration) feeding the Brightness/Contrast inputs of `Bright.Contrast`.
- **Complexity:** Low — 8 nodes / 8 conns.
- **Port interest:** Trivial utility; skip.
- **Source:** `Wire/Patches/Bright.Contrast Smooth`

### Burn Out
- **What it does:** A "burn out" flash effect — on trigger, an ADSR-shaped envelope ramps saturation/contrast boost and an alpha modulate to blow out the image, then decays back.
- **Technique:** Momentary/Metronome trigger → `Step`/`Snapshot` + Attack/Release-Time `ADSR Output` envelope; `Atan` soft-clip curves; Saturation/Contrast Boost into `Bright.Contrast`; `Modulate Alpha` + `Cross Fader` blend; Target-FPS-normalized timing.
- **Complexity:** Medium — 55 nodes / 66 conns.
- **Port interest:** Moderately compelling — the ADSR-driven exposure-blowout grade is a nice reusable building block.
- **Source:** `Wire/Patches/Burn Out`

### BurnFade
- **What it does:** A transition mixer that wipes between two sources using a gradient-driven "burn" threshold so the fade dissolves along a moving ramp rather than a flat crossfade.
- **Technique:** `Gradient` + `Transform`/`Scale` + Curve build a threshold ramp fed into `Mixer`/`Video Mixer` with Opacity; Add offsets the ramp over time.
- **Complexity:** Low — 13 nodes / 13 conns.
- **Port interest:** Mildly interesting (gradient-mask dissolve); common transition, low priority.
- **Source:** `Wire/Patches/BurnFade`

### Character Prompter
- **What it does:** A text source that reveals a string character-by-character (typewriter), stepping through substrings on a metronome with sub-steps, each character/step popping in via an envelope.
- **Technique:** `Text` + `Length` + `Substring` with Int/Modulo/Snapshot/Delay counters advancing Steps/Sub-Steps; Metronome + Duty Cycle + `Attack Release` for per-character reveal; `Text Render` with Scale/Color/Alignment.
- **Complexity:** Medium — 38 nodes / 48 conns.
- **Port interest:** Niche text effect; the substring-stepping logic is reusable but text rendering is platform-specific.
- **Source:** `Wire/Patches/Character Prompter`

### Character Sweeper
- **What it does:** A text source that sweeps a highlight/reveal across the characters of a string, cycling through substrings with an enveloped sweep position.
- **Technique:** `Text`/`Length`/`Substring` + `Sweep` + Attack Release + Duty Cycle; Cycle Delay + On-Change advance; `Text Render` Scale/Color/Alignment; Less/Switch select visible chars.
- **Complexity:** Low/Medium — 21 nodes / 23 conns.
- **Port interest:** Niche text effect; low priority.
- **Source:** `Wire/Patches/Character Sweeper`

### ChromaWobble
- **What it does:** A triggered chromatic-aberration wobble — on trigger it ramps a fractal-noise UV displacement plus per-channel hue offset and blur, wobbling the image with RGB fringing that decays via temporal smoothing.
- **Technique:** `Fractal Noise` + Saw + `UV Offset`/`Displace` for the wobble field; `Hue Rotate` (x2) + per-channel offset for chroma split; `Attack Release` (Duration) + Trigger/Greater/If gating; `Blur` + `Temporal Smoothing` (Delay) + `Video Mixer`.
- **Complexity:** Medium — 45 nodes / 54 conns.
- **Port interest:** Compelling — noise-driven UV displacement + chroma split is a clean fragment/compute effect worth porting.
- **Usage (team):** Used, but needs re-architecting — **port as a v2** tuned for efficiency rather than a faithful copy.
- **Source:** `Wire/Patches/ChromaWobble`

### Dodge Blend
- **What it does:** A color-dodge blend mixer between two inputs with an auto-mask and saturation/contrast/curve grading on the blend.
- **Technique:** Two `Mixer` nodes (dodge) + `Auto Mask` + `Bright.Contrast` + `Saturation` + Curve/Map; Opacity control.
- **Complexity:** Low — 11 nodes / 12 conns.
- **Port interest:** Trivial utility (standard dodge blend mode); skip.
- **Source:** `Wire/Patches/Dodge Blend`

### Dynamical
- **What it does:** An optical-flow style advection effect: builds a flow/displacement field from the image and iteratively pushes pixels along it, creating fluid smearing/streaking with rotation, choke and contrast control, composited over the source.
- **Technique:** Custom ISF `Radial Stretch Sample` — for each pixel it probes the flow texture at 8 random nearby offsets and keeps the max-magnitude directional gradient, emitting a 2D offset rotated into a Basis (Flow Rotation via Sin/Cos); fed back through `Delay` + `UV Map`/`UV Texture` + `Pixel Blur` (Detail) as an iterative advection buffer; `Video Mixer` composite.
- **Complexity:** Medium — 37 nodes / 40 conns.
- **Port interest:** Very compelling — iterative flow-field advection with a feedback buffer; a natural ping-pong compute-shader port.
- **Source:** `Wire/Patches/Dynamical`

### EGG Simulator
- **What it does:** A near-passthrough joke/utility effect that applies two hue rotations (with comments) to the input.
- **Technique:** `Hue Rotate` x2 between Texture In/Out. Mostly empty.
- **Complexity:** Low — 6 nodes / 3 conns.
- **Port interest:** Trivial/novelty; skip.
- **Source:** `Wire/Patches/EGG Simulator`

### Flow & Diverge
- **What it does:** Same advection engine as Dynamical but adds a divergence/brake term so the flow can spread/repel as well as smear, with a sampling-width control — fluid-like streaking that can expand outward.
- **Technique:** Custom ISF `Radial Stretch Sample` (8-sample max-gradient flow field) + `Diverge`/`Brake`/`Sampling Width`; `Gate`/`Less`/`Absolute` thresholding; `Delay` feedback advection buffer + `Pixel Blur`; `Video Mixer`.
- **Complexity:** Medium — 52 nodes / 59 conns.
- **Port interest:** Very compelling — flow advection + divergence; ping-pong compute port.
- **Source:** `Wire/Patches/Flow & Diverge`

### Flow & Diverge Self
- **What it does:** The Flow & Diverge advection, but self-driven — the flow field is derived from the image's own content/feedback rather than an external flow input.
- **Technique:** Identical node set to Flow & Diverge minus the separate `Flow Texture` input; same `Radial Stretch Sample` ISF + Delay feedback + Diverge/Brake/Sampling-Width.
- **Complexity:** Medium — 51 nodes / 59 conns.
- **Port interest:** Very compelling (self-advecting feedback flow); same compute-port story as Flow & Diverge.
- **Source:** `Wire/Patches/Flow & Diverge Self`

### Frame Zoom
- **What it does:** Draws a resizable rectangular frame/border (aspect-ratio aware) over the output — a framing/overlay graphic with adjustable scale and line thickness.
- **Technique:** `Shape Render` (Rectangle + Edge) with Aspect X/Y → Aspect Ratio, Scale, Line Thickness; no input texture (source-style overlay).
- **Complexity:** Low — 11 nodes / 12 conns.
- **Port interest:** Trivial utility (procedural border); skip.
- **Source:** `Wire/Patches/Frame Zoom`

### Freeze Pulse
- **What it does:** On beat/threshold triggers it freezes (holds) a frame and pulses it — randomly scaling/jittering/flipping the held snapshot and blending modes (with a probabilistic mode bag and overrides) for a stutter-freeze glitch.
- **Technique:** `Snapshot` frame-hold latched by Beat/Main Trigger + On-Change; `Bag` + Switch Probability + Case Count for random mode selection; Random + Jitter Mod + Max-Scale-Modulate + `Transform`; `Attack Release` transition; Bright.Contrast intensity pop; `Video Mixer`.
- **Complexity:** High — 91 nodes / 113 conns.
- **Port interest:** Compelling — frame-freeze + randomized-mode stutter is a strong glitch building block; snapshot becomes a captured texture.
- **Source:** `Wire/Patches/Freeze Pulse`

### Gen SphereLines
- **What it does:** A generative overlay drawing concentric/latitudinal lines on a rotating 3D sphere (wireframe-globe look) with a Z-sweep animation, FOV projection and randomized levels.
- **Technique:** Per-level Saw/Random + Curve drive circle radii; `Circle`/`Pie`/`Edge` via `Shape Render`; perspective scale by Z-Sweep + FOV (Divide); Transform/Sweep animation; Line Count/Width controls; composited over input.
- **Complexity:** Medium — 53 nodes / 60 conns.
- **Port interest:** Compelling — procedural 3D sphere-line projection; would port to an instanced line/SDF compute pass.
- **Source:** `Wire/Patches/Gen SphereLines`

### Gen SpherePoints
- **What it does:** Generative overlay scattering a grid of points mapped onto a rotating sphere surface (point-cloud globe), with sweep, warp, FOV projection and per-point sizing.
- **Technique:** Grid index → spherical coords via Atan2/Sin/Cos + Angle; `Warp`/Sweep-Strength deformation; FOV/Divide perspective; per-point Random + Curve; `Shape Render` (Rectangle/Grid) points with Point Size; over input.
- **Complexity:** Medium/High — 64 nodes / 78 conns.
- **Port interest:** Compelling — sphere point-cloud projection; instanced-quad compute port.
- **Source:** `Wire/Patches/Gen SpherePoints`

### Gentle Difference
- **What it does:** A soft "difference"-style mixer between two sources with eased transitions and saturation/contrast taming so the difference blend looks gentle rather than harsh.
- **Technique:** LHS/RHS inputs, two `Transition` nodes + 4 `Curve` easings, `1 - x`, `Bright.Contrast` + `Saturation`, Opacity.
- **Complexity:** Low — 13 nodes / 17 conns.
- **Port interest:** Trivial utility (eased difference blend); skip.
- **Source:** `Wire/Patches/Gentle Difference`

### Glitch Revolver
- **What it does:** A datamosh-style glitch that scatters rectangular grain blocks arranged radially ("revolver") around a center, each block randomly UV-shifted and alpha-varied on metronome triggers, displacing the image.
- **Technique:** Custom ISF `Packed Channel Blend` — samples a "beauty" image at a UV displaced by an offset packed into RGBA (xy=offset*alpha, z=alpha mult) of a second texture; the offset map is built by `Shape Render` rectangles placed via Atan2/Magnitude/Cos/Sin (radial), Random + Pack + Snapshot per-block params, Metronome/Trigger/Limit scheduling.
- **Complexity:** High — 82 nodes / 101 conns.
- **Port interest:** Compelling — packed-offset displacement driven by procedurally-placed grain blocks; strong glitch port.
- **Source:** `Wire/Patches/Glitch Revolver`

### Glitch Revolver 2
- **What it does:** Refined Glitch Revolver — same radial packed-offset block-shift glitch with added envelope (Attack Release / Env Trigger/Time/Amount) modulation and v7.14 rect-fix/flip nodes.
- **Technique:** Same `Packed Channel Blend` ISF + radial rect placement (Atan2/Magnitude/Cos/Sin) + Random/Pack/Snapshot; adds `Attack Release` enveloped intensity, `To Float2`/`Fix Rect`/`Flip Y` corrections.
- **Complexity:** High — 91 nodes / 113 conns.
- **Port interest:** Compelling (same as Glitch Revolver, with envelope control); good glitch port.
- **Source:** `Wire/Patches/Glitch Revolver 2`

### Graysweep
- **What it does:** Recolors the image by its luminance — sweeping grayscale values onto a target color ramp (a tint/duotone-by-luma grade) with gamma and clamp.
- **Technique:** `Unpack` + luma via Sqrt/Power, `Color`/`Color In` ramp, Multiply/Add to blend toward target color, `Curve`/`Clamp`/Power shaping.
- **Complexity:** Low — 14 nodes / 15 conns.
- **Port interest:** Trivial utility (luma-to-color tint); skip.
- **Source:** `Wire/Patches/Graysweep`

### HVEN Sphere Sim
- **What it does:** Maps the input texture onto a fake 3D LED sphere — an equirectangular projection onto a rotatable globe made of ~48x5 panels plus top/bottom poles, with simulated inter-panel gaps, per-panel tint and UV quantization to mimic fixed panel pixel resolution.
- **Technique:** Custom ISF `shader` — reverse-projects screen coords to a unit sphere, applies yaw/pitch/roll rotation matrices, converts to equirect UV, computes per-panel coarse/fine coords with `tan`-warped latitude bands, drops gap/pole regions, quantizes UV to PANEL_PIXELS, samples input; node graph supplies Yaw/Pitch/Roll/Panel Gap/Tint/BG Alpha via Transform + Divide.
- **Complexity:** Low node-count / High shader — 13 nodes / 12 conns (logic lives in the ISF).
- **Port interest:** Very compelling — a self-contained LED-sphere panel mapper; ideal single-shader port (the node graph is just parameter plumbing).
- **Source:** `Wire/Patches/HVEN Sphere Sim`

### Horizontal Glitch
- **What it does:** A horizontal tearing/displacement glitch — each scanline is shifted left/right by a noise value scaled by a per-row "amount" map, triggered/intensified on beats for bursts of horizontal datamosh.
- **Technique:** Custom ISF `Remap` (per-row horizontal displace = noiseRow*2-1 * amountRow*strength) fed by custom ISF `RandomNoise` (per-row white noise, Phase-scrolled) and an `Auto Mask`/Blur-derived amount map; Beat Trigger + Random Rate + Counter + Attack Release drive Trigger Intensity; Bright.Contrast/Motion grading.
- **Complexity:** Medium/High — 55 nodes / 61 conns.
- **Port interest:** Compelling — per-scanline noise-driven horizontal displacement is a clean, classic glitch shader to port.
- **Source:** `Wire/Patches/Horizontal Glitch`

### Horizontal Striation
- **What it does:** Smears the image into horizontal streaks where each row is dominated by its brightest/most-saturated pixel, gated and animated by a noise-thresholded sweep with feedback trails.
- **Technique:** ISF `Resize` (point-samples to a 32-wide grid) + ISF `ReduceMaxSat` (scans 32 horizontal samples per row, keeps the one maximizing a luma↔saturation mix). Fractal Noise + threshold sweep + Snapshot/Delay feedback drive where striation activates; Pixel Blur smooths.
- **Complexity:** High (83 nodes / 102 conns)
- **Port interest:** Compelling — the row-wise max-saturation reduction is a distinctive stylization rarely seen elsewhere.
- **Source:** `Wire/Patches/Horizontal Striation`

### Hue
- **What it does:** Transplants chosen hue/saturation/lightness channels from one input texture onto another (a two-source HSL channel-mix blend).
- **Technique:** ISF `ToHSL`/`FromHSL` use a YIQ-based pseudo-HSL (hue from atan2 of I/Q, chroma from magnitude, Y as lightness); `ChannelMix` per-channel `mix(lhs,rhs,alpha)` selects which HSL components cross over. Unpack/Map/Clamp wire the channel weights.
- **Complexity:** Low–Medium (14 nodes / 16 conns)
- **Port interest:** Distinctive — selective HSL-channel transplant between two streams, more than a plain hue shift.
- **Source:** `Wire/Patches/Hue`

### Isolate Motion
- **What it does:** Extracts only the moving regions of the input by frame-differencing against a delayed copy, producing a motion-keyed output (static areas suppressed).
- **Technique:** Delay + Subtract + Absolute frame difference → Clamp/Power, then Temporal Smoothing, Dilate, and Blur to clean the motion mask; Saturation/Bright.Contrast stages with "Kill Grays"/"Preserve Colors"/Luma Curve shape the result. No ISF.
- **Complexity:** Medium–High (43 nodes / 51 conns)
- **Port interest:** Compelling — temporal frame-difference motion isolation is a reusable, distinctive building block.
- **Source:** `Wire/Patches/Isolate Motion`

### LUT
- **What it does:** Applies a selectable 3D color LUT to the image, with a bank of presets, pregain, color-masking and crossfade between graded/original.
- **Technique:** ISF `LUTShader` (standard 512×512, 8×8 tile, 64-level Instagram-style cube LUT with blue-axis bilinear blend). Switch picks among 10 baked `Image` LUTs; Color Mask + Video Mixer limit/blend the grade.
- **Complexity:** Medium (33 nodes / 39 conns)
- **Port interest:** Utility — solid LUT engine with preset selector + masking; standard but well-built.
- **Source:** `Wire/Patches/LUT`

### LUT 2
- **What it does:** Stripped-down LUT grader: selectable preset LUT applied with pregain and alpha, no masking.
- **Technique:** Same ISF `LUTShader` cube-LUT lookup; simpler wiring (Switch/Add to pick LUT, Pregain, Multiply, 1/x).
- **Complexity:** Low (24 nodes / 25 conns)
- **Port interest:** Trivial/utility — simplified variant of `LUT`.
- **Usage (team):** Actively used — but **implement more efficiently** on port. The baked static LUT resources are good; keep them as-is.
- **Source:** `Wire/Patches/LUT 2`

### LUT Glitch
- **What it does:** Applies a selectable LUT while scaling/anchoring/transforming the LUT-sampling space, producing glitchy color shifts and channel packing.
- **Technique:** ISF `LUTShader` cube LUT fed through Transform (Scale X/Y, Anchor) + Pack + Filter + Color Mask, so the LUT readout is spatially distorted rather than 1:1.
- **Complexity:** Medium (44 nodes / 52 conns)
- **Port interest:** Distinctive — LUT-as-glitch (warped LUT sampling) is more interesting than straight grading.
- **Source:** `Wire/Patches/LUT Glitch`

### Luma Modulate
- **What it does:** Modulates pixel brightness/alpha by a power curve of its own luma (max channel), keying bright areas up or down.
- **Technique:** ISF `Alpha Curve`: `baseAlpha = max(r,g,b)`, `alpha = pow(baseAlpha, power)`, then scales rgb by `alpha/baseAlpha`; blended back by opacity. (Same shader as Alpha Modulate.)
- **Complexity:** Low (7 nodes / 6 conns)
- **Port interest:** Trivial/utility — single-shader luma curve.
- **Source:** `Wire/Patches/Luma Modulate`

### Luma Modulate 2
- **What it does:** Same luma-power brightness/alpha modulation as Luma Modulate, but built entirely from native nodes (no shader).
- **Technique:** Power + Curve + threshold (Greater/Switch) + Subtract/Clamp/Map reconstruct the `pow(luma)` modulation on the texture.
- **Complexity:** Low (12 nodes / 15 conns)
- **Port interest:** Trivial/utility — shader-free reimplementation of the luma curve.
- **Source:** `Wire/Patches/Luma Modulate 2`

### Luma Range Sweep
- **What it does:** Selects pixels whose luma (or distance to a reference color) falls within a sweeping band and outputs that selection as a mask/alpha.
- **Technique:** No ISF. Reference Color + Dot Product/Normalize + Luma, then a Sweep with adjustable Bandwidth and Subtract/Absolute/1-x produce an animated band-pass over luminance, written to Alpha via Mask.
- **Complexity:** Medium (25 nodes / 29 conns)
- **Port interest:** Distinctive — animated luminance band-pass selector, useful as a keying/transition primitive.
- **Source:** `Wire/Patches/Luma Range Sweep`

### Mask ArcSlice
- **What it does:** Generates an animated arc/slice mask (radial wedge shapes that push/pull and ripple) and uses it to mask and reshape the input.
- **Technique:** No ISF. Shape Render of a Rectangle through Suckr/Fish Eye/Push/Pull/Ripple deformers driven by Speed/Phase/Saw, plus Vignette + Edge Soft + Blur; Transition/Mask composite the procedural mask onto the texture with output transform.
- **Complexity:** High (65 nodes / 71 conns)
- **Port interest:** Compelling — rich procedural animated arc-slice mask generator.
- **Source:** `Wire/Patches/Mask ArcSlice`

### Mask Mix
- **What it does:** Blends two inputs using one input's channel (unpacked) as a per-pixel mask.
- **Technique:** No ISF. Unpack → Mask drives a Mixer/Video Mixer between Texture In A/B with Opacity.
- **Complexity:** Low (7 nodes / 7 conns)
- **Port interest:** Trivial/utility — masked crossfade.
- **Source:** `Wire/Patches/Mask Mix`

### Masked Disolve
- **What it does:** Transition mixer that reveals the lighter parts of the incoming texture first (luma-ordered dissolve).
- **Technique:** No ISF. Threshold on the new texture's luma with a Smoothness softening band drives a Mask → Video Mixer; `1-x` controls direction.
- **Complexity:** Low (9 nodes / 9 conns)
- **Port interest:** Distinctive (small) — luma-ordered dissolve transition, nicer than a linear crossfade.
- **Source:** `Wire/Patches/Masked Disolve`

### MultiplyAdd
- **What it does:** Blends two inputs via multiply then adds a curved/saturated contribution on top.
- **Technique:** No ISF. Mixer (multiply) + Add + Curve + Saturation + Replace Alpha, with Opacity.
- **Complexity:** Low (14 nodes / 17 conns)
- **Port interest:** Trivial/utility — composite blend mode.
- **Source:** `Wire/Patches/MultiplyAdd`

### MultiplyMultiply
- **What it does:** Multiply blend of two inputs with a solid-color tint and crossfade.
- **Technique:** No ISF. Multiply + Cross Fader + Solid Color, with Opacity.
- **Complexity:** Low (7 nodes / 6 conns)
- **Port interest:** Trivial/utility — blend mode.
- **Source:** `Wire/Patches/MultiplyMultiply`

### On Alpha
- **What it does:** Composites two inputs keyed on alpha (over-style mix gated by alpha).
- **Technique:** No ISF. Map/Clamp on alpha drives a Video Mixer between the two inputs with Opacity.
- **Complexity:** Low (9 nodes / 9 conns)
- **Port interest:** Trivial/utility — alpha-keyed blend.
- **Source:** `Wire/Patches/On Alpha`

### PXL Shift Trail
- **What it does:** Pixelates the image and shifts blocks by sweeping X/Y pixel offsets (with swirl/rotate steps), leaving decaying trails. Runs at 512×512.
- **Technique:** No ISF. Mesh 2D / 2D Render of a Rectangle with pixel-size quantization (PXL Size), Sweep + Sweep Bandwidth selecting shifted regions, Shift X/Y Pixels, Rotate/Swirl Step, Color Exclusion, and Transition-based feedback for trails.
- **Complexity:** High (78 nodes / 92 conns)
- **Port interest:** Compelling — distinctive pixel-block shift-with-trails datamosh aesthetic.
- **Source:** `Wire/Patches/PXL Shift Trail`

### Part Scroll
- **What it does:** Divides the (portrait) frame into N vertical slices and scrolls/sweeps a selected slice band along Y.
- **Technique:** No ISF. Slice Count/Index + Min/Max Y define a band, Sweep + Transform translate it, Map/Multiply scale.
- **Complexity:** Low–Medium (17 nodes / 19 conns)
- **Port interest:** Modest — slice-scroll utility; mildly distinctive.
- **Source:** `Wire/Patches/Part Scroll`

### Pixulant
- **What it does:** A roiling, dissolving pixel-scatter feedback effect that progressively "dives" the image into churning displaced grain.
- **Technique:** ISF `Radial Stretch Sample` (per-pixel random scatter displacement, salt-seeded hash, aspect-corrected) + ISF `Difference` (abs frame-difference blend). Dive/Scatter/Exposure with On Change/Saw/Smooth and many Curves drive an iterative feedback loop.
- **Complexity:** High (44 nodes / 53 conns)
- **Port interest:** Compelling — signature scatter-feedback "simulant" look; the Radial Stretch + Difference pair is the reusable core.
- **Usage (team):** **Infinitely useful** despite a weird shader with dead code. Critical port note: the "dive" reportedly relied on a quirk of Wire's *difference* blend — subtracting an image from itself did NOT yield pure black, it left a halo. That non-black-difference behavior is **load-bearing**; reproduce or deliberately replace it, don't "fix" it away.
- **Source:** `Wire/Patches/Pixulant`

### Playground
- **What it does:** Uncategorized scratch/test patch wiring video players, generated shapes (Triangle, Chevron), transforms, chaos/random and transitions together.
- **Technique:** No ISF. Mixed grab-bag: 2× Video Player, Shape Render, UV Offset, Move/Transform, Random/Chaos, Video Mixer, Transition.
- **Complexity:** Medium–High (65 nodes / 80 conns)
- **Port interest:** Low as a whole (experimental/test sketch), though individual sub-graphs are reusable.
- **Source:** `Wire/Patches/Playground`

### Pulsed Tunnel
- **What it does:** Creates a pulsing radial tunnel: noise-driven UV displacement pulled toward center, with feedback trails and brightness pulsing.
- **Technique:** No ISF. Multiple Fractal Noise layers (cutoff/softness/contrast/phase) modulate UV Texture/UV Map feedback; Sqrt + Center Bias build the radial field, Trail Length controls feedback decay, Blur/Bright.Contrast finish.
- **Complexity:** High (62 nodes / 80 conns)
- **Port interest:** Compelling — generative noise-tunnel with feedback; strong source/effect candidate.
- **Source:** `Wire/Patches/Pulsed Tunnel`

### Pulsed Tunnel 2
- **What it does:** Beat-reactive radial pinch/tunnel that sucks the image inward with random scatter, texturized warping and edge boost.
- **Technique:** ISF `Radial Stretch Sample` (random scatter) + `RandomNoise` (hashed RGBA noise). Suckr (radial pinch) + Texturize Warp + Fractal Noise grain + Stretch Bias, gated by a beat trigger (Transport Beat/Metronome/Counter) with attack-release envelope.
- **Complexity:** High (65 nodes / 72 conns)
- **Port interest:** Compelling — beat-driven radial pinch tunnel; distinctive and performance-ready.
- **Source:** `Wire/Patches/Pulsed Tunnel 2`

### RGB Dst Red
- **What it does:** Composites the top input onto the bottom keyed by the destination (bottom) red channel, with blur/transition controls.
- **Technique:** No ISF. Replace Alpha from a red-channel-derived key, Greater/Switch threshold, Blur, Saturation, Transition, Solid Color, dual Video Mixers.
- **Complexity:** Medium (25 nodes / 30 conns)
- **Port interest:** Utility-ish — channel-keyed compositing; specific but niche.
- **Source:** `Wire/Patches/RGB Dst Red`

### Replace Alpha
- **What it does:** Replaces the image's alpha with a supplied alpha value/channel.
- **Technique:** No ISF. Alpha → Replace Alpha, passthrough.
- **Complexity:** Low (4 nodes / 3 conns)
- **Port interest:** Trivial/utility.
- **Source:** `Wire/Patches/Replace Alpha`

### Reveal
- **What it does:** Crops the frame from each edge (left/right/top/bottom reveal).
- **Technique:** No ISF. Single Crop node fed by Left/Right/Top/Bottom amounts.
- **Complexity:** Low (7 nodes / 6 conns)
- **Port interest:** Trivial/utility — edge crop.
- **Source:** `Wire/Patches/Reveal`

### SLIDE_TEST
- **What it does:** Slides the image in/out along X on a trigger, with a reversible attack-release ramp.
- **Technique:** No ISF. Slide transform driven by Attack Release + Trigger, Reverse/Switch for direction, Float2/X offset.
- **Complexity:** Low (12 nodes / 11 conns)
- **Port interest:** Trivial/utility/test — triggered slide transition.
- **Source:** `Wire/Patches/SLIDE_TEST`

### SPHR Billboard
- **What it does:** Places the input texture as a positionable flat "billboard" plane within an LED-sphere/dome equirectangular projection (controllable plane yaw/pitch/depth and perspective amount).
- **Technique:** ISF `SPHR Billboard` reverse-projects each equirect pixel through sphere rotation matrices onto a perspective plane (`1/(1-z)` projection) and samples the texture only inside the plane's UV bounds; the shared sphere `shader` handles screen→hemisphere→equirect mapping with panel gaps.
- **Complexity:** Low node count, heavy shader (9 nodes / 8 conns)
- **Port interest:** Compelling — sphere/dome billboard projection; specialized but distinctive projection-mapping tool.
- **Source:** `Wire/Patches/SPHR Billboard`

### SPHR Blur
- **What it does:** Seam-correct blur for equirectangular (sphere/dome) content, so blurring doesn't break across the lat/long wrap.
- **Technique:** ISF `SPHR Expand` (`latlonTranspose` computes sphere-aware horizontal sample spacing, then a max/dilate accumulation across the grid; invert→min/erode) combined with a Gaussian Blur and Quality control.
- **Complexity:** Low–Medium (15 nodes / 16 conns)
- **Port interest:** Distinctive — equirect-aware blur; useful infrastructure for any spherical pipeline.
- **Usage (team):** Amazingly useful **even off-sphere** — don't gate it behind a spherical assumption. The math is likely wrong but the look is fine; don't over-invest in correctness.
- **Source:** `Wire/Patches/SPHR Blur`

### SPHR ChromaSplit
- **What it does:** Spherical RGB chroma-split/jitter: separates the color channels and offsets/hue-rotates them along a 3D (yaw/pitch) cycling axis on the sphere, with envelope-driven intensity.
- **Technique:** ISF `Radial Stretch Sample` + `Difference`. Per-channel Hue Rotate + R/G/B Jitter, a cycling axis (Cos/Sin/Saw with yaw/pitch/radius), Attack Release envelope routed to cycle and jitter amounts, threshold sweep gating.
- **Complexity:** High (99 nodes / 113 conns)
- **Port interest:** Compelling — elaborate spherical chromatic-aberration/jitter; strong distinctive effect.
- **Source:** `Wire/Patches/SPHR ChromaSplit`

### SPHR Displace
- **What it does:** Displaces one texture (LHS) along the luminance gradient of another (RHS) in sphere-correct equirectangular space.
- **Technique:** ISF `Gradient Displace Sample` samples RHS luma at sphere-aware neighbor offsets (`latlonTranspose`), computes the gradient, and shifts LHS UVs by `grad*Strength` with lat/long wrap + foldback; ISF `Difference` available too.
- **Complexity:** Low node count, heavy shader (7 nodes / 6 conns)
- **Port interest:** Compelling — equirect gradient-driven displacement; reusable spherical warp primitive.
- **Source:** `Wire/Patches/SPHR Displace`

### SPHR Displace Grad
- **What it does:** Same as SPHR Displace — sphere-correct luma-gradient displacement of LHS by RHS (identical shader/node set, alternate preset).
- **Technique:** ISF `Gradient Displace Sample` (+ `Difference`); identical wiring to SPHR Displace.
- **Complexity:** Low (7 nodes / 6 conns)
- **Port interest:** Compelling (duplicate of SPHR Displace) — same equirect gradient displacement.
- **Source:** `Wire/Patches/SPHR Displace Grad`

### SPHR Expand
- **What it does:** Morphological dilate/expand (or erode when inverted) over equirectangular content, scaling bright/alpha regions outward without seam artifacts.
- **Technique:** ISF `SPHR Expand` only — sphere-aware sample spacing via `latlonTranspose`, then max-accumulate (dilate) or min-accumulate (erode) across a quality-scaled grid; Scale/Invert exposed.
- **Complexity:** Low (6 nodes / 5 conns)
- **Port interest:** Distinctive — equirect morphological dilate/erode; clean reusable spherical primitive.
- **Source:** `Wire/Patches/SPHR Expand`

### SPHR Grad
- **What it does:** Sphere-correct gradient displacement with selectable mode, sampling distance and response curve (a tunable variant of SPHR Displace).
- **Technique:** ISF `Gradient Displace Sample` (+ `Difference`) with Mode, Sampling Distance (Divide), and a Curve shaping the displacement strength.
- **Complexity:** Low–Medium (10 nodes / 9 conns)
- **Port interest:** Distinctive — parameterized equirect gradient-displace.
- **Source:** `Wire/Patches/SPHR Grad`

### SPHR Jitter
- **What it does:** Adds animated jitter/shake to spherical content by randomly nudging yaw/pitch on a beat, smoothed and crossfaded.
- **Technique:** Shared sphere `shader` (screen→hemisphere→equirect rotation with panel gaps) + ISF `SPHR Expand`; Metronome + Random + Smooth + Cross Fader drive Yaw/Pitch jitter with a cycle-rate variance and All Scale.
- **Complexity:** Medium (27 nodes / 29 conns)
- **Port interest:** Distinctive — beat-jittered spherical rotation; good motion primitive for dome content.
- **Source:** `Wire/Patches/SPHR Jitter`

### SPHR Line Blaster
- **What it does:** A generative source that emits radial bursts of HSL-colored lines (charge → blast) with motion blur, intended for spherical/dome mapping.
- **Technique:** No ISF. Large node graph: Charge/Trigger system (Metronome/Counter/Charge curves) drives line Speed/Width; HSL color (Hue/Saturation/Lightness ranges), Rectangle Shape Render in a Circular transform, Motion Blur, many Cross Faders/Maps/Clamps.
- **Complexity:** High (173 nodes / 207 conns)
- **Port interest:** Compelling — complex generative line-burst source; ambitious and distinctive.
- **Source:** `Wire/Patches/SPHR Line Blaster`

### SPHR Line Logistic
- **What it does:** A generative source that positions/animates lines using a chaotic logistic-map recurrence, drawn as rectangles (for spherical mapping).
- **Technique:** No ISF. Logistic recurrence built from repeated `R * x * (1-x)` multiply chains (the heavy `R`/`x`/`1-x`/Multiply histogram), with Sort, Range/Start Y/Rate, triggers and Snapshots feeding Rectangle Shape Render.
- **Complexity:** High (155 nodes / 218 conns)
- **Port interest:** Compelling — logistic-map-driven line generator; mathematically distinctive source.
- **Source:** `Wire/Patches/SPHR Line Logistic`

### SPHR Lines
- **What it does:** Overlays a procedural line grid onto an equirectangular (lat-long) panorama and applies a sphere-aware blur so the grid/source reads correctly when wrapped onto an LED dome/sphere.
- **Technique:** Custom ISF `SPHR Expand`: maps each screen UV through a latitude/longitude→sphere transform (`latlonTranspose`, yaw/pitch rotation matrices), computes how a small angular delta projects to a screen-space search region, then does an adaptive grid box-blur (the disabled `main_expand` variant instead does a max-dilate). Driven by a `Grid` generator + `Solid Color` mixed via `Video Mixer`, with `Quality` controlling sample-grid size.
- **Complexity:** Low (14 nodes / 15 conns) — but a sophisticated shader.
- **Port interest:** Compelling — the spherical-aware adaptive blur is a genuinely distinctive equirectangular technique worth porting.
- **Source:** `Wire/Patches/SPHR Lines`

### SPHR Pixulant
- **What it does:** A feedback "dive/zoom" simulation that repeatedly radially stretches and scatters the previous frame, building a recursive tunnel/pixel-flow look with exposure and local-contrast shaping.
- **Technique:** Custom ISFs `Radial Stretch Sample` (radial UV stretch sampling) and `Difference`; heavy `Curve`×11 / `Multiply`×10 modulation chain, `Scatter`/`Scatter 2` displacement, `Saw`+`Motion` time drive, `Smooth`, `Local Contrast`, `Invert RGB`, feedback via `Video Mixer`. Controls: `Dive`, `Dive Cap`, `Dive Tight`, `Exposure`.
- **Complexity:** Medium (58 nodes / 72 conns).
- **Port interest:** Distinctive feedback-zoom + scatter aesthetic; the curve-heavy modulation is the bulk, radial-stretch shader is the core trick.
- **Source:** `Wire/Patches/SPHR Pixulant`

### SPHR Quantize
- **What it does:** Renders a simulated LED-sphere/dome: reverse-projects screen pixels onto a rotatable sphere split into 48×5 panels (with pole disks, panel gaps, fixed-resolution quantization), and feeds it a generative content sim of sparkle/diffusion dynamics.
- **Technique:** Custom ISF `shader` = full sphere panel projection (yaw/pitch/roll rotation, equirectangular UV, per-panel gap warping, `PANEL_PIXELS` UV quantization, panel tint). Content from `Sparkle`/`Dynamics` (random per-pixel UV jump with wraparound + alpha decay — a stochastic diffusion), `Gather Maximum` (max-pooling downsample by max RGB channel), plus `Resize`, `Boost Compress/Dodge`, beat-synced `Send`.
- **Complexity:** High (79 nodes / 114 conns, 5 ISF shaders).
- **Port interest:** Very compelling — combines the LED-dome projector with a custom cellular sparkle/diffuse simulator; several independently portable shaders.
- **Source:** `Wire/Patches/SPHR Quantize`

### SPHR Rotate
- **What it does:** Projects an input texture onto a virtual LED sphere (48×5 panels) and lets you orbit it via Yaw/Pitch (roll), with simulated panel gaps and a tintable panel-enhance mode.
- **Technique:** Custom ISF `shader` (identical sphere-panel projector as SPHR Quantize): screen→sphere unproject, yaw/pitch/roll rotation matrices, equirectangular sampling, panel-gap warp + pole handling, UV quantization to panel pixel grid, alpha for off-sphere background. `SPHR Expand` ISF also present (sphere-aware blur).
- **Complexity:** Low (5 nodes / 4 conns) — thin patch wrapping one rich shader.
- **Port interest:** Compelling — the cleanest entry point to the LED-dome projection shader.
- **Source:** `Wire/Patches/SPHR Rotate`

### SPHR Rotate Yaw-Pitch
- **What it does:** Near-identical variant of SPHR Rotate — texture-onto-LED-sphere projection with Yaw/Pitch orbit controls.
- **Technique:** Same sphere panel-projection `shader` ISF (48×5 panels, gap warp, pole disks, UV quantization) plus `SPHR Expand`. Effectively a renamed/duplicate of SPHR Rotate.
- **Complexity:** Low (5 nodes / 4 conns).
- **Port interest:** Duplicate of SPHR Rotate; port one, not both.
- **Source:** `Wire/Patches/SPHR Rotate Yaw-Pitch`

### Sampling Revolver
- **What it does:** A glitchy video player/looper source that jumps between 8 stored playhead positions, slips/seeks, and randomly flips, producing stutter-and-revolve resampling of a clip.
- **Technique:** `Video Player` with `In/Out Point`, `Force Seek`/`Jump Trigger`; 8 `Pos` snapshots stored via `Snapshot`×8 / `Delay`×10, beat-`Metronome`-driven `Switch`/`If` logic, `Slip Snapshot`/`Seeked Snapshot`, NaN/derivative guards, `Flip Chance`, `Barrel` distortion. No custom ISF.
- **Complexity:** High (99 nodes / 126 conns).
- **Port interest:** Distinctive playhead-slip/jump sequencer logic; portable as a stutter-loop engine but no shader novelty.
- **Source:** `Wire/Patches/Sampling Revolver`

### Sampling Revolver 2
- **What it does:** Effect-category rework of Sampling Revolver: frame-step resampling/freeze of an incoming texture stream with beat-synced sweeps, holds, and pulse-driven re-sampling.
- **Technique:** `Frame Step`×2, `Counter`/`Modulo` frame addressing, `Snapshot`, `Switch`×9 routing, `Attack Release`/`Pulse` envelopes, `Metronome`×4 with `Min/Max Frequency`, `Resample Random`, `Bypass Hold`. No custom ISF.
- **Complexity:** High (91 nodes / 113 conns).
- **Port interest:** Frame-buffer stutter/resample logic; useful utility-ish engine, no shader.
- **Source:** `Wire/Patches/Sampling Revolver 2`

### Screener
- **What it does:** Simple "screen blend" style look — desaturates/contrast-adjusts the input and screen-mixes it against a solid color.
- **Technique:** `Saturation` → `Bright.Contrast` → `Add Subtract` → `Video Mixer` against a `Solid Color`. No custom shader.
- **Complexity:** Low (8 nodes / 7 conns).
- **Port interest:** Trivial utility color/blend patch.
- **Source:** `Wire/Patches/Screener`

### Scroll
- **What it does:** Scrolls/tiles the input texture by an X/Y offset using a 2D mesh-rendered quad (wraparound panning).
- **Technique:** `Rectangle`→`Mesh 2D`→`2D Render` with `Box 2D` UV addressing; X/Y `Float2` offset added, normalized by `Dimension`/`Divide`. No custom shader.
- **Complexity:** Low (17 nodes / 20 conns).
- **Port interest:** Trivial UV-scroll utility.
- **Source:** `Wire/Patches/Scroll`

### Simulant
- **What it does:** A reaction-diffusion-style "living" feedback effect: a delayed/zoomed copy of the frame is edge-detected, posterized, level-shaped and flickered, then composited back to grow organic line structures over the input.
- **Technique:** Feedback loop via `Delay`→`Transform`(Zoom/Anchor/Scale)→`Pixel Blur`→`Edge Detection`→`Posterize`→`Levels`, with `Replace Alpha`, flicker envelope (`A Flicker Rate/Min/Max/Release`, `Attack Release`, `Random`), colorize/color-filter, `Wave Speed`. No custom ISF (all built-in nodes).
- **Complexity:** High (78 nodes / 86 conns).
- **Port interest:** Distinctive generative feedback "growth" simulator; flagship of the Simulant family.
- **Source:** `Wire/Patches/Simulant`

### Simulant 2nd Order
- **What it does:** Simulant with a 2nd-order (spring-mass) temporal integrator added — the feedback level evolves with velocity/acceleration/spring dynamics for bouncier, momentum-driven growth.
- **Technique:** Same edge-detect/posterize/level feedback core as Simulant, plus an explicit physics integrator: `Velocity`×2, `Acceleration`, `Spring Constant`, `Decay Factor`, `Integration Time Scale`, `Feedback`, `Diff` (state delta). `Aux Line Strength` second output.
- **Complexity:** High (97 nodes / 108 conns).
- **Port interest:** Distinctive — adds a hand-rolled spring-damper temporal solver on top of the feedback sim.
- **Source:** `Wire/Patches/Simulant 2nd Order`

### Simulant HQ
- **What it does:** Higher-quality Simulant variant — same growth feedback effect tuned for fidelity with extra `Resize` stages instead of relying on blur alone.
- **Technique:** Same Simulant feedback core (`Edge Detection`/`Posterize`/`Levels`/`Pixel Blur`/`Transform` zoom) but with `Resize`×3 (supersample) replacing some smoothing; colorize/color-filter and flicker envelope retained.
- **Complexity:** High (77 nodes / 83 conns).
- **Port interest:** Quality variant of Simulant; port the base Simulant and parameterize quality.
- **Source:** `Wire/Patches/Simulant HQ`

### Simulant MarkII
- **What it does:** Rebuilt Simulant using a Perlin-noise-seeded spring feedback — cleaner edge/levels chain with explicit `Spring` integrator and noise-driven flicker.
- **Technique:** `Spring` node (built-in 2nd-order), `Perlin Noise`, `Flicker`/`Flicker Frequency`/`Flicker Mod`, `Edge Detection`×2, `Posterize`, `Levels`, `Pixel Blur`×2, `Resize`×2, `Contrast Curve`, multiple `Video Mixer`/`Replace Alpha` composites.
- **Complexity:** Medium-High (59 nodes / 71 conns).
- **Port interest:** Distinctive cleaner re-architecture of the Simulant feedback growth.
- **Source:** `Wire/Patches/Simulant MarkII`

### Simuline
- **What it does:** Stripped-down single-pass Simulant — edge-detect + posterize + levels line extraction with a blur and alpha replace, no feedback/flicker.
- **Technique:** `Blur`→`Edge Detection`→`Posterize`→`Levels`→`Map`→`Replace Alpha`→`Crop`, `Line Width`/`Line Strength`/`Smoothing` params. No custom ISF, no feedback loop.
- **Complexity:** Low (13 nodes / 12 conns).
- **Port interest:** Trivial/utility — the static line-extraction core of the Simulant family.
- **Source:** `Wire/Patches/Simuline`

### Sinkhole
- **What it does:** A gravity-well displacement effect that pushes/pulls pixels toward a moving center with velocity/damping accumulation and per-channel chromatic offset, creating a swirling sinkhole warp.
- **Technique:** Custom ISF `Offset`: reads a displaceMap red channel and offsets R/G/B channels independently along separate XY directions (chromatic-aberration displacement). Push/Pull center physics (`Velocity`, `Damping`, `Push/Pull Scale/Multiplier`), `Gradient`+`Blur` build the displacement field, `Hue Rotate`×3, beat-driven `Trigger`.
- **Complexity:** Medium-High (64 nodes / 76 conns).
- **Port interest:** Compelling — accumulating velocity/damping displacement field plus per-channel chroma offset shader.
- **Source:** `Wire/Patches/Sinkhole`

### Small Waves
- **What it does:** Generates fine rippling wave distortion over the input — jittered, edge-detected, posterized line field blurred and composited to look like small surface waves.
- **Technique:** Feedback via `Delay`, `Jitter`/`Jitter X/Y/Aux` offsets, `Transform`×4, `Blur`×4, `Edge Detection`+`Posterize`+`Levels`, `Damping`/`Spread`/`Presoft`/`Soft Shape`, `Render Scale`/`Quality` supersample. No custom ISF.
- **Complexity:** Medium-High (63 nodes / 72 conns).
- **Port interest:** Sibling of Simulant (line-feedback) tuned for small jitter waves; moderately distinctive.
- **Source:** `Wire/Patches/Small Waves`

### Sprite Jump
- **What it does:** Makes the whole frame behave like a bouncing sprite — it jumps/lands on a beat with squash-and-stretch, height variance, motion blur and lens distortion on impact.
- **Technique:** Jump physics from curves (`Jump Curve`/`Land Curve`, `T Jump`/`T Squash`/`Height`/`Land Time`), `Transform` scale/translate, `Can Jump` gating, beat `Metronome`+`Trigger Jump`, `Motion Blur`, `Fish Eye`/`Ripple`/`Suckr` impact lensing, `Zoom`. No custom ISF.
- **Complexity:** High (150 nodes / 181 conns).
- **Port interest:** Distinctive procedural squash-stretch bounce rig; lots of nodes but mostly math/curve plumbing.
- **Source:** `Wire/Patches/Sprite Jump`

### Stutter Scale
- **What it does:** Beat-stuttered scale/zoom glitch — randomly re-scales, flips, hue-shifts and color-inverts the frame in stutters, with motion and jitter.
- **Technique:** `Switch`×7 random routing, `Random`×5, `Min/Max Scale` `Transform`, `Flip Y`×4, `Hue Rotate`×3, `Within`/`Atan` deadzone shaping, `Sweep`/`Saw` time drive, `Snapshot` hold, `Invert RGB`. No custom ISF.
- **Complexity:** High (88 nodes / 111 conns).
- **Port interest:** Distinctive beat-glitch scale-stutter logic; portable as a glitch engine, no shader.
- **Source:** `Wire/Patches/Stutter Scale`

### Stutter Scale 2
- **What it does:** Stutter Scale with an added envelope stage — same scale/flip/hue stutter glitch plus an `Attack Release` env (Env Time/Trigger) modulating intensity.
- **Technique:** Same node set as Stutter Scale (`Switch`×8, `Random`×5, `Flip Y`×4, scale `Transform`, `Hue Rotate`, `Sweep`) plus `Attack Release`/`Env Time`/`Env Trigger`.
- **Complexity:** High (96 nodes / 120 conns).
- **Port interest:** Incremental variant of Stutter Scale; port the base and add the envelope param.
- **Source:** `Wire/Patches/Stutter Scale 2`

### Stutter Scale Text
- **What it does:** Stutter Scale applied to rendered text — animated/stuttered scaling, hue and flip glitch on a `Text Render` source instead of incoming video.
- **Technique:** `Text Render`×2 with `Substring`/`Length`/`Text Crop`/`Kern`/`Line Spacing`/`Alt Font`, then the Stutter Scale glitch chain (`Switch`×4, `Random`×5, scale `Transform`, `Hue Rotate`×3, `Sweep`, `Invert RGB`). No custom ISF.
- **Complexity:** High (88 nodes / 118 conns).
- **Port interest:** Text-source variant of Stutter Scale; distinctive if you want glitched typography.
- **Source:** `Wire/Patches/Stutter Scale Text`

### Subtle Blur
- **What it does:** Light blur with a slowly-drifting random chromatic color offset for a soft, subtly shifting bloom.
- **Technique:** `Blur`×2, `Color Offset` driven by `Saw`+`Random`+`Hue Rotate`×3 unpack/pack, `Map`/`Amount`/`Movement` params. No custom ISF.
- **Complexity:** Low (24 nodes / 29 conns).
- **Port interest:** Trivial/utility soft-blur with drifting chroma.
- **Source:** `Wire/Patches/Subtle Blur`

### Test Shape Antialias
- **What it does:** Test-source patch rendering a shape (rectangle) to verify shape-render antialiasing/edge quality.
- **Technique:** `Shape Render`+`Rectangle`+`Transform`, `Int In`/`Floor`/`Linear` to step a test parameter, `Replace Alpha`, `Solid Color` background. No custom ISF.
- **Complexity:** Low (11 nodes / 11 conns).
- **Port interest:** Trivial test/scratch patch.
- **Source:** `Wire/Patches/Test Shape Antialias`

### Text Cards
- **What it does:** A text-card source generator that slides/twirls multiple rendered text panels in on beat with gradient backgrounds and oscillating motion (lower-third / title-card style).
- **Technique:** `Text Render`×2, `Slide`×7 / `Twirl`×2 transitions, `Sine Oscillator`×2 LFO motion, beat sync (`Transport Beat`/`Bpm to Frequency`/`Beat Divider`/`Gate Length`), `Gradient`/`Gradient Saturation/Shape`, `Suckr` lens, an embedded logo image (`Hyraxclubtokyo_logo...`). No custom ISF.
- **Complexity:** High (84 nodes / 92 conns).
- **Port interest:** Distinctive animated title-card system; useful as a motion-graphics template.
- **Source:** `Wire/Patches/Text Cards`

### The Complex Sim
- **What it does:** A large generative source: a flicker/pulse-bar light simulation that sorts and shuffles indexed bars/shapes, drives them with random flicker modes and beat pulses to make a complex animated light-grid composition.
- **Technique:** Array/data nodes (`Bag`×3, `Sort`×2, `Shuffle`, `Insert`/`Write`/`Read`, `Indices`, `Span`, `Drill`), `Flicker`×3 with multiple modes (`Flicker Full/Dual P`, `Random Flicker`), `Pulse Bar`×2, `Shape Render`×3 (Circle/Rectangle), `Curve`×16 modulation, beat sync. No custom ISF.
- **Complexity:** Very High (235 nodes / 280 conns).
- **Port interest:** Compelling but heavy — a data-driven multi-element light simulator; the array/sort/bag scheduling logic is the interesting part.
- **Source:** `Wire/Patches/The Complex Sim`

### Trianguplace
- **What it does:** Tiles/places shuffled triangles to progressively cover the frame with the input texture — a chaos-driven triangular mosaic/displacement-placement effect.
- **Technique:** Triangle placement engine: `Triangle`/`Triangle Data`/`Triangle Limit`, `Shape Render`×2, `Shuffle`/`Reshuffle` with `Chaos`/`Quantize`, per-triangle `Place X/Y/Scale/Rotation`, `Is Fully Covered` termination, `Read`/`Pack` data store, `Move`/`Distance` stepping. No custom ISF.
- **Complexity:** High (79 nodes / 99 conns).
- **Port interest:** Distinctive procedural triangle-tiling/coverage algorithm.
- **Source:** `Wire/Patches/Trianguplace`

### Untitled
- **What it does:** Scratch mixer patch — two texture inputs cross-faded by an Opacity into a Video Mixer (with comment notes).
- **Technique:** `Texture In`×2 → `Video Mixer` with `Opacity`; two `Comment` nodes. No custom ISF.
- **Complexity:** Low (7 nodes / 4 conns).
- **Port interest:** Trivial scratch/template mixer — skip.
- **Source:** `Wire/Patches/Untitled`

### UpDown Curve
- **What it does:** Sweeps a luma/value range up and down over time and remaps it through a curve to alpha — an animated range-gate/wipe on a property.
- **Technique:** `Range`+`Sweep` define a moving window, `Map`/`Clamp`/`Subtract`/`Smooth` shape it, `Curve` remap, `Replace Alpha` output, `Duration` timing. No custom ISF.
- **Complexity:** Low (19 nodes / 22 conns).
- **Port interest:** Trivial/utility animated range remap.
- **Source:** `Wire/Patches/UpDown Curve`

### Video Skippy
- **What it does:** A video-player source that randomly skips/jumps the playhead and varies playback rate on a metronome, for stuttery clip mangling.
- **Technique:** `Video Player` with `Position`/`Snapshot`, beat `Metronome`×2 + `Trigger`×2 driving random skips (`Skip Min/Max %`, `Skip Min/Max s`), `Min/Max Rate`+`Rate Variance`+`Rate Scale` playback-speed randomization, `Smooth`. No custom ISF.
- **Complexity:** Low-Medium (33 nodes / 39 conns).
- **Port interest:** Simple random-seek/rate clip player; utility-grade.
- **Source:** `Wire/Patches/Video Skippy`

### Whisp It
- **What it does:** A wispy feedback smoke/flow effect — crops and masks the input, then advects it through a chaos/flow field with feedback, alpha grain and vignette to dissolve it into drifting whisps.
- **Technique:** Pre-crop transform (`In Crop X/Y/Zoom/Rotation/Soft`), `Chaos Texture`+`Chaos Motion` flow field, feedback via `Send`/`Delay`+`Feedback`/`Speed`, `Displace`×2 advection, `Alpha Grain`/`Chaos Grain`/`Static`, `Edge Mask`/`Linear Cutoff`, `Vignette`×2, inverse-transform matrices (`Inv Translation/Rotation/Scale`). No custom ISF.
- **Complexity:** Very High (156 nodes / 195 conns).
- **Port interest:** Compelling — a full advection/feedback flow dissolve with crop+mask rig; rich but large.
- **Source:** `Wire/Patches/Whisp It`

### Wobble Master
- **What it does:** A beat-reactive wobble/ripple distortion with chromatic-aberration color fringing — pulses warp the frame outward from a center on beat, blurred and hue-tinted.
- **Technique:** UV-displacement field from `Gradient`/`Ripple`/`Sine`/`Sin`/`Cos`/`UV Offset`×4, beat pulse (`Beat Trigger`/`Pulse Time`/`Trigger at Threshold`/`Attack Release`), `Color Mask`×4 + `Chroma Hue`/`Chroma Easing` for per-channel chroma offset, `Center/Edge Smooth`, `Wave Speed`. No custom ISF (built-in nodes only).
- **Complexity:** Very High (142 nodes / 183 conns).
- **Port interest:** Distinctive beat-pulse wobble + chroma rig; the base of the Wobble family.
- **Source:** `Wire/Patches/Wobble Master`

### Wobble Master 2
- **What it does:** Wobble Master upgraded with a dedicated chromatic-offset shader and a retriggerable pulse system — beat-synced wobble with cleaner hue-rotated channel fringing.
- **Technique:** Custom ISF `ChromaOffset` (YIQ-space hue shift + per-channel UV offset driven by an offsetMap red channel) and `Magnitude` (RGB length → displacement magnitude). Retrigger logic (`Pulse Retrigger`/`Gate`/`Retrigger Phase`/`Counter`/`Max BPM`), `Ripple`/`Sin`/`Cos` UV field, `Pulse Texture`/`Pulse Attack`.
- **Complexity:** Very High (204 nodes / 246 conns, 2 ISF).
- **Port interest:** Compelling — the YIQ ChromaOffset shader (hue-rotated chromatic aberration via displacement map) is a clean, reusable port candidate.
- **Usage (team):** The Wobble Master family (Master / 2 / Fast) is used but **likely needs re-architecting — port as a v2**. The YIQ `ChromaOffset` shader is the keeper.
- **Source:** `Wire/Patches/Wobble Master 2`

### Wobble Master Fast
- **What it does:** Performance-optimized Wobble Master 2 — same beat-wobble + chroma-fringe effect with the ChromaOffset shader, trimmed for speed.
- **Technique:** Custom ISF `ChromaOffset` (YIQ hue shift + map-driven per-channel UV offset); UV wobble field (`Ripple`/`Sin`/`Cos`/`UV Offset`), pulse retrigger (`Pulse Retrigger`/`Gate`/`Retrigger Phase`), `Gradient`/`Color`-driven chroma, `Magnitude` via `Hue Rotate`. Uses `Pack`-based fast paths vs WM2.
- **Complexity:** Very High (174 nodes / 212 conns, 1 ISF).
- **Port interest:** Optimized sibling of Wobble Master 2; port WM2 and use this for perf reference.
- **Source:** `Wire/Patches/Wobble Master Fast`

### ZoomScroller
- **What it does:** Animates a sequenced pan-and-zoom tour across the frame — generates randomized step sequences (positions, scales, angles) and tweens the camera between them in sub-steps, with an on-screen gizmo and edge-color handling.
- **Technique:** Sequence engine: `Start/Target/Current/Tween Pos`, `Shuffle`/`Sort` step order, `Sub Steps`/`Sub Delay`/`Frames Per Sub Step` timing, `Running Total`/`Deltas`/`Sum` distance accumulation, polar `Target Min/Max Angle/Radius` placement, `Transform` zoom, `Gizmo` overlay (`Shape Render`), custom ISF `edge-color` (edge-pixel fill). Massive `Pack`/`Unpack`×13 data plumbing.
- **Complexity:** Very High (259 nodes / 335 conns).
- **Port interest:** Compelling — a full procedural pan/zoom sequence camera with sub-step tweening; the sequencing logic is the standout.
- **Source:** `Wire/Patches/ZoomScroller`

### test
- **What it does:** Scratch/test patch — passes input through two Hue Rotate nodes (with comments). No real effect logic.
- **Technique:** `Texture In`→`Hue Rotate`×2→`Texture Out`, two `Comment` nodes. No custom ISF.
- **Complexity:** Low (6 nodes / 3 conns).
- **Port interest:** Trivial scratch patch — skip.
- **Source:** `Wire/Patches/test`
