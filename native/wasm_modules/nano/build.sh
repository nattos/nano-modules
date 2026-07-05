#!/bin/bash
set -e
cd "$(dirname "$0")"
OUT_DIR="${1:-../../../build/wasm}"
TMP_DIR="${2:-../../build/tmp}"
mkdir -p "$OUT_DIR" "$TMP_DIR"
MODULE_NAME=nano

echo "=== Compiling shaders (nano) ==="
source ../wasm_build_env.sh

# motion_field — image-driven motion vector generator. Two compute
# shaders sharing common.hlsl (DXC handles #include automatically).
compile_shaders_compute_var_spv motion_field color
compile_shaders_compute_var_spv motion_field motion
_emit_spv_header_var motion_field color motion
echo "  motion_field shaders compiled (SPV: color + motion)"

# flash_particles — mask-driven particle compositor.
#   update  (compute) — per-particle lifetime + respawn.
#   prefill (compute) — copy a source tex (× scale) to a dest storage
#                       tex. Same SPV is registered twice with
#                       different storage-format hints (color = rgba8,
#                       motion = rgba16f) so each PSO gets the right
#                       naga substitution.
#   vs      (vertex)  — instanced quad vertex shader, shared by both
#                       fragment passes.
#   fs_color  (pixel) — color compositing, blends onto pre-filled
#                       tex_out. Two PSOs (alpha and additive blend)
#                       share this fragment.
#   fs_motion (pixel) — motion vectors with mask=alpha; alpha blend
#                       acts as a mask-controlled overwrite.
compile_shaders_compute_var_spv flash_particles update
compile_shaders_compute_var_spv flash_particles prefill
dxc -T vs_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../flash_particles/vs.hlsl -Fo "$TMP_DIR/flash_particles_vs.spv"
dxc -T ps_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../flash_particles/fs_color.hlsl -Fo "$TMP_DIR/flash_particles_fs_color.spv"
dxc -T ps_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../flash_particles/fs_motion.hlsl -Fo "$TMP_DIR/flash_particles_fs_motion.spv"
_emit_spv_header_var flash_particles update prefill vs fs_color fs_motion
echo "  flash_particles shaders compiled (SPV: update + prefill + vs + fs_color + fs_motion)"

# flow_swarm — flow-field-driven GPU particle swarm (consumes a flow_field rail).
compile_shaders_compute_var_spv flow_swarm update
compile_shaders_compute_var_spv flow_swarm prefill
dxc -T vs_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../flow_swarm/vs.hlsl -Fo "$TMP_DIR/flow_swarm_vs.spv"
dxc -T ps_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../flow_swarm/fs.hlsl -Fo "$TMP_DIR/flow_swarm_fs.spv"
dxc -T vs_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../flow_swarm/density_vs.hlsl -Fo "$TMP_DIR/flow_swarm_density_vs.spv"
dxc -T ps_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../flow_swarm/density_fs.hlsl -Fo "$TMP_DIR/flow_swarm_density_fs.spv"
compile_shaders_compute_var_spv flow_swarm density_debug
_emit_spv_header_var flow_swarm update prefill vs fs density_vs density_fs density_debug
echo "  flow_swarm shaders compiled (SPV: update + prefill + vs + fs + density + debug)"

# local_delay — stylized motion-driven local delay. Pyramidal Lucas-Kanade
# flow + forward-advection lookup, sharing common.hlsl:
#   luma     — input → half-res Rec.601 luma (downsample first).
#   down     — 2x2 luma pyramid downsample (half→quarter→eighth).
#   lk       — windowed structure-tensor Lucas-Kanade, one level (run 3x).
#   upsample — half-res flow → full res.
#   align    — colinear flow polish + temporal flow EMA + mask + index.
#   color    — forward-advect along the flow, sample the input at the endpoint.
#   motion   — modulated render_outputs/motion.
# luma/down write r32float; lk/upsample/align/motion write rgba16f;
# color writes rgba8.
compile_shaders_compute_var_spv local_delay luma
compile_shaders_compute_var_spv local_delay down
compile_shaders_compute_var_spv local_delay lk
compile_shaders_compute_var_spv local_delay upsample
compile_shaders_compute_var_spv local_delay align
compile_shaders_compute_var_spv local_delay color
compile_shaders_compute_var_spv local_delay motion
_emit_spv_header_var local_delay luma down lk upsample align color motion
echo "  local_delay shaders compiled (SPV: luma+down+lk+upsample+align+color+motion)"

# height_from_gradient — GPU gradient-domain height reconstruction. Multigrid
# Poisson solve, sharing common.hlsl:
#   gradient   — input → RG gradient field (radial × luma).
#   divergence — g → F_0 = div(g).
#   restrict   — pre-scaled divergence pyramid (2x2 sum).
#   jacobi     — one relaxation sweep (reused across levels).
#   prolong    — coarse height → fine initial guess (bilinear upsample).
#   present    — hillshade / grayscale / normals.
# gradient/divergence/restrict/jacobi/prolong write rgba16f (scalar in R);
# present writes rgba8.
compile_shaders_compute_var_spv height_from_gradient gradient
compile_shaders_compute_var_spv height_from_gradient divergence
compile_shaders_compute_var_spv height_from_gradient restrict
compile_shaders_compute_var_spv height_from_gradient jacobi
compile_shaders_compute_var_spv height_from_gradient prolong
compile_shaders_compute_var_spv height_from_gradient mm_seed
compile_shaders_compute_var_spv height_from_gradient mm_reduce
compile_shaders_compute_var_spv height_from_gradient present
_emit_spv_header_var height_from_gradient gradient divergence restrict jacobi prolong mm_seed mm_reduce present
echo "  height_from_gradient shaders compiled (SPV: gradient+divergence+restrict+jacobi+prolong+mm_seed+mm_reduce+present)"

# shape_fold — evolving-shape generator. CPU resolves a baked atlas to a few
# terms; the GPU evaluates the SDF field and auto-levels it every frame
# (sharing common.hlsl):
#   minmax   — atomic field min/max over an SN×SN grid (storage buffer).
#   hist     — atomic histogram over the same grid.
#   buildlut — invert the histogram into a median→0 CLAHE remap LUT.
#   present  — auto-leveled field → grayscale / magma, square-fit (rgba8).
#   edge     — motion/variance reduce over tex_out → int stats buffer (skip-static).
#   debug    — per-tile feature heatmap over tex_out (skip-static tuning view).
compile_shaders_compute_var_spv shape_fold minmax
compile_shaders_compute_var_spv shape_fold hist
compile_shaders_compute_var_spv shape_fold buildlut
compile_shaders_compute_var_spv shape_fold present
compile_shaders_compute_var_spv shape_fold edge
compile_shaders_compute_var_spv shape_fold debug
_emit_spv_header_var shape_fold minmax hist buildlut present edge debug
echo "  shape_fold shaders compiled (SPV: minmax+hist+buildlut+present+edge+debug)"

# brutal_fold — brutalist axonometric-prism generator. CPU resolves a baked
# control surface (complexity × order × liveliness, + a co-folded second
# structure) to two structures' terms; the GPU composites the receding prism
# layers with depth fog in a single pass (the solid threshold is CPU-resolved,
# so no auto-levels):
#   present  — composite both structures' depth layers → grayscale (rgba8).
#   edge     — Sobel + variance reduce over tex_out → int stats buffer (skip-empty).
compile_shaders_compute_var_spv brutal_fold present
compile_shaders_compute_var_spv brutal_fold edge
compile_shaders_compute_var_spv brutal_fold debug
_emit_spv_header_var brutal_fold present edge debug
echo "  brutal_fold shaders compiled (SPV: present + edge + debug)"

# phase_fold — emergent limit-cycle phase-portrait generator. A baked atlas of
# limit-cycle fields is uploaded to the GPU; the field, streamline tracing,
# arrow animation and limit-cycle integration all run as GPU compute passes,
# rasterized as soft line quads (sharing common.hlsl/field.hlsl):
#   backdrop — blended scalar field H, diverging bands (rgba8 storage tex).
#   stream   — NS×NS streamline tracer + animated arrowheads (segment buffer).
#   cycle    — limit-cycle integrator + marker (segment buffer).
#   line_vs/line_fs — instanced soft-line raster over the backdrop.
compile_shaders_compute_var_spv phase_fold backdrop
compile_shaders_compute_var_spv phase_fold stream
compile_shaders_compute_var_spv phase_fold solve
compile_shaders_compute_var_spv phase_fold cycle
compile_shaders_compute_var_spv phase_fold select
compile_shaders_compute_var_spv phase_fold flow
dxc -T vs_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../phase_fold/line_vs.hlsl -Fo "$TMP_DIR/phase_fold_line_vs.spv"
dxc -T ps_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../phase_fold/line_fs.hlsl -Fo "$TMP_DIR/phase_fold_line_fs.spv"
dxc -T vs_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../phase_fold/contour_vs.hlsl -Fo "$TMP_DIR/phase_fold_contour_vs.spv"
dxc -T ps_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../phase_fold/contour_fs.hlsl -Fo "$TMP_DIR/phase_fold_contour_fs.spv"
_emit_spv_header_var phase_fold backdrop stream solve cycle select flow line_vs line_fs contour_vs contour_fs
echo "  phase_fold shaders compiled (SPV: backdrop+stream+solve+cycle+select+flow+line+contour)"

# triangulate — topology-following GPU Delaunay triangulation. Feature maps
# (blur + derivatives) → JFA Voronoi → stochastic-takeover seed relaxation →
# triple-point Delaunay edges rasterized as instanced line quads.
#   downsample — viewport input → proc-res (linear sampler).
#   feature    — pre-blurred input → ridge/corner/density importance field (rgba16f).
#   jfa_init/splat/step — Jump-Flood Voronoi over the seed pool (r32float id tex).
#   score_clear/score   — per-cell mass/centroid/argmax-importance candidate (atomics).
#   takeover   — stochastic confidence-gated seed teleport.
#   present    — importance/voronoi/points/input → tex_out (debug + mesh compositing).
#   (uses the shared fx::GaussianBlur → needs blur_shaders.h for effect_blur.h.)
compile_shaders_compute_spv blur
compile_shaders_compute_var_spv triangulate downsample
compile_shaders_compute_var_spv triangulate feature
compile_shaders_compute_var_spv triangulate hist
compile_shaders_compute_var_spv triangulate cdf
compile_shaders_compute_var_spv triangulate remap
compile_shaders_compute_var_spv triangulate jfa_init
compile_shaders_compute_var_spv triangulate jfa_splat
compile_shaders_compute_var_spv triangulate jfa_step
compile_shaders_compute_var_spv triangulate score_clear
compile_shaders_compute_var_spv triangulate score
compile_shaders_compute_var_spv triangulate seed_prep
compile_shaders_compute_var_spv triangulate takeover
compile_shaders_compute_var_spv triangulate present
compile_shaders_compute_var_spv triangulate edge_clear
compile_shaders_compute_var_spv triangulate edges
dxc -T vs_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../triangulate/line_vs.hlsl -Fo "$TMP_DIR/triangulate_line_vs.spv"
dxc -T ps_6_0 -E main -spirv -fspv-target-env=vulkan1.1 \
  -I "$SHADERS_COMMON_DIR" \
  ../triangulate/line_fs.hlsl -Fo "$TMP_DIR/triangulate_line_fs.spv"
_emit_spv_header_var triangulate downsample feature hist cdf remap jfa_init jfa_splat jfa_step score_clear score seed_prep takeover present edge_clear edges line_vs line_fs
echo "  triangulate shaders compiled (SPV: downsample+feature+jfa+score+takeover+present+edges+lines; blur)"

# plane_shear — analysis-driven shear / rift. Sharing common.hlsl:
#   accumulate — coarse-grid gradient scatter → stats buffer (atomic, selected alg).
#   solve      — single-thread reduction → latched plane (center + normal).
#   render     — per-pixel inverse-mapped shear warp (rift / overlap / slip).
compile_shaders_compute_var_spv plane_shear accumulate
compile_shaders_compute_var_spv plane_shear solve
compile_shaders_compute_var_spv plane_shear render
_emit_spv_header_var plane_shear accumulate solve render
echo "  plane_shear shaders compiled (SPV: accumulate + solve + render)"

# tri_shear — three-plane triangle shear. accumulate.hlsl #includes plane_shear's
# (shared grid); solve.hlsl finds 3 lines; render.hlsl is plane_shear's render + a
# line_index selecting one of the 3 edges (host chains it 3× with ping-pong textures).
compile_shaders_compute_var_spv tri_shear accumulate
compile_shaders_compute_var_spv tri_shear solve
compile_shaders_compute_var_spv tri_shear render
_emit_spv_header_var tri_shear accumulate solve render
echo "  tri_shear shaders compiled (SPV: accumulate + solve + render)"

# shape_burst — triggered expanding-ring generator. Two compute passes sharing
# common.hlsl: `compute` rasterizes concentric circle/square/triangle rings over
# a background (black / transparent / custom / input); `motion` writes the
# radial per-ring velocity to the render_outputs/motion rail (gated on connect).
compile_shaders_compute_var_spv shape_burst compute
compile_shaders_compute_var_spv shape_burst motion
_emit_spv_header_var shape_burst compute motion
echo "  shape_burst shaders compiled (SPV: compute + motion)"

# simulant — faithful port of the Resolume Wire "Simulant" patch: a
# difference-blend + blur-diffusion feedback loop thresholded into Sobel lines.
#   inject — abs(fadedPrev - input) difference-blend feedback (rgba16f).
#   blur   — separable RGB Gaussian; wave-diffusion (+decay) and line smoothing.
#   lines  — Levels → posterize → Sobel → crop line extraction (rgba8).
compile_shaders_compute_var_spv simulant inject
compile_shaders_compute_var_spv simulant blur
compile_shaders_compute_var_spv simulant lines
_emit_spv_header_var simulant inject blur lines
echo "  simulant shaders compiled (SPV: inject + blur + lines)"

# smear — directional Pixulant. Two compute shaders over the same tilted footprint:
#   blur    — one separable directional axis pass (run 2×: major then minor).
#   scatter — Pixulant-style salted scatter + dive/difference/exposure cascade.
compile_shaders_compute_var_spv smear blur
compile_shaders_compute_var_spv smear scatter
_emit_spv_header_var smear blur scatter
echo "  smear shaders compiled (SPV: blur + scatter)"

# line_reconstruct — SMAA-like morphological line/point reconstructor + deband.
# Multi-pass classify-then-resolve (all sharing common.hlsl); uses the shared
# fx::GaussianBlur (blur_shaders.h, compiled above for triangulate) for the
# fixed-sigma scale-space pyramid, structure-tensor smoothing, and colour blurs.
#   stats/cstar  — Rec.709 luma, 3x3 min/max/contrast, 9x9-max CAS normalizer.
#   blur16       — RGBA16F separable Gaussian (precision/sign-preserving; used for
#                  the scale-space pyramid, tensor smoothing, and colour blurs).
#   tensor_grad/tensor — Scharr products → structure-tensor coherence + junction.
#   features     — per-scale ridge/blob, softmax scale-blend, width, offsets → M0..M3.
#   smooth_prep/smooth — polarity/orientation coherence + confidence-weighted
#                  smoothing of the feature fields (blur products grouped by sigma).
#   ctr_prep/centerline — the fp16-safe shared centerline (relative-coord centroid).
#   reconstruct  — pass 6: bilinear flank/center taps → crisp box-AA repaint +
#                  deband, gated + hierarchically composited → tex_out (rgba8).
compile_shaders_compute_var_spv line_reconstruct stats
compile_shaders_compute_var_spv line_reconstruct cstar
compile_shaders_compute_var_spv line_reconstruct blur16
compile_shaders_compute_var_spv line_reconstruct tensor_grad
compile_shaders_compute_var_spv line_reconstruct tensor
compile_shaders_compute_var_spv line_reconstruct features
compile_shaders_compute_var_spv line_reconstruct smooth_prep
compile_shaders_compute_var_spv line_reconstruct smooth
compile_shaders_compute_var_spv line_reconstruct ctr_prep
compile_shaders_compute_var_spv line_reconstruct centerline
compile_shaders_compute_var_spv line_reconstruct reconstruct
_emit_spv_header_var line_reconstruct stats cstar blur16 tensor_grad tensor features smooth_prep smooth ctr_prep centerline reconstruct
echo "  line_reconstruct shaders compiled (SPV: stats+cstar+blur16+tensor+features+smooth+centerline+reconstruct)"

echo "=== Building WASM (nano) ==="

WASM_COMMON_EXPORTS=(
  -Wl,--export=nano_module_main
  -Wl,--export=malloc
  -Wl,--export=free
  -Wl,--export=__indirect_function_table
)

wasm_build \
  -I"$TMP_DIR" \
  -I../include \
  -I../../src \
  main.cpp \
  ../nanolooper/main.cpp \
  ../nanolooper/core.cpp \
  ../motion_field/main.cpp \
  ../flash_particles/main.cpp \
  ../local_delay/main.cpp \
  ../height_from_gradient/main.cpp \
  ../shape_fold/main.cpp \
  ../brutal_fold/main.cpp \
  ../phase_fold/main.cpp \
  ../flow_swarm/main.cpp \
  ../spectral_lfo/main.cpp \
  ../spectral_lfo/spectral_curve.cpp \
  ../mod_spectral/main.cpp \
  ../triangulate/main.cpp \
  ../plane_shear/main.cpp \
  ../tri_shear/main.cpp \
  ../shape_burst/main.cpp \
  ../simulant/main.cpp \
  ../smear/main.cpp \
  ../line_reconstruct/main.cpp

echo "Built: $OUT_DIR/$MODULE_NAME.wasm ($(wc -c < "$OUT_DIR/$MODULE_NAME.wasm")B)"
