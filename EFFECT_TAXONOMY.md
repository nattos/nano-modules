# Effect Taxonomy — APPLIED

Scheme: `domain.[group.]name` · first component = category = colour key · bundle is separate metadata.

This remap is live: all effect ids, display names, and categories below are the
current registrations. The `← old id` column is kept as a historical record of
the pre-rename ids.

Total: 80 effects.


## source  (22)

All source effects now declare the `Generator` capability (separate from the
`source` taxonomy domain). Some also sample an optional input to composite over.

| new id | display | ← old id | bundle | gen.cap | note |
|---|---|---|---|---|---|
| `source.gradient` | Gradient | `generator.gradient` | core | Y |  |
| `source.grid` | Grid | `generator.grid` | core | Y |  |
| `source.light.bounce_resonator` | Bounce Resonator | `gen.bounce_resonator` | lights | Y |  |
| `source.light.chroma_wave` | Chroma Wave | `gen.chroma_wave` | lights | Y |  |
| `source.light.motion_blobs` | Motion Blobs | `gen.motion_blobs` | lights | Y | also emits motion |
| `source.light.orthomod` | Orthomod | `gen.orthomod` | lights | Y |  |
| `source.light.plasma_beam_cannon` | Plasma Beam Cannon | `gen.plasma_beam_cannon` | lights | Y |  |
| `source.light.side_jet` | Side Jet | `gen.side_jet` | lights | Y |  |
| `source.light.soft_glow` | Soft Glow | `gen.soft_glow` | lights | Y |  |
| `source.light.strobe_channel` | Strobe Channel | `gen.strobe_channel` | lights | Y |  |
| `source.light.tingle_top` | Tingle Top | `gen.tingle_top` | lights | Y |  |
| `source.noise` | Noise | `generator.noise` | core | Y |  |
| `source.particles.flash_particles` | Flash Particles | `video.flash_particles` | nano | Y | JUDGMENT: mask-driven compositor |
| `source.particles.flow_swarm` | Flow Swarm | `video.flow_swarm` | nano | Y | JUDGMENT: consumes flow_field rail |
| `source.phase_fold` | Phase Fold | `video.phase_fold` | nano | Y | was video.* |
| `source.pixel.descent` | Pixel Descent | *(new)* | nano | Y | beat-locked stepping grid |
| `source.pixel.ocean` | Pixel Ocean | *(new)* | nano | Y | pixel-art wave sprites |
| `source.pixel.rift` | Pixel Rift | *(new)* | nano | Y | ocean waves crossing a hidden mid-rift |
| `source.shape_fold` | Shape Fold | `video.shape_fold` | nano | Y | was video.* |
| `source.solid_color` | Solid Color | `generator.solid_color` | core,testonly | Y |  |
| `source.text.plain` | Text | `gen.text` | text | Y |  |
| `source.text.rich` | Rich Text | `gen.richtext` | richtext | Y |  |

## color  (14)

| new id | display | ← old id | bundle | gen.cap | note |
|---|---|---|---|---|---|
| `color.color_space` | Color Space | `video.color_space` | core |  |  |
| `color.colorize` | Colorize | *(new)* | core |  |  |
| `color.hsl` | HSL | `video.hsl` | core |  |  |
| `color.hue_basis` | Hue Basis | `video.hue_basis` | core |  |  |
| `color.invert` | Invert | `video.invert` | core |  |  |
| `color.posterize` | Posterize | `video.posterize` | core |  |  |
| `color.saturate` | Saturate | `video.saturate` | core |  |  |
| `color.temperature` | Color Temperature | `video.color_temperature` | core |  |  |
| `color.tone.auto_level` | Auto Level | `video.auto_level` | core |  |  |
| `color.tone.brightness_contrast` | Brightness & Contrast | `video.brightness_contrast` | core,testonly |  | drop slash |
| `color.tone.curve` | Curve | `video.curve` | core |  |  |
| `color.tone.exposure` | Exposure | `video.exposure` | core |  |  |
| `color.tone.levels` | Levels | `video.levels` | core |  |  |
| `color.vibrance` | Vibrance | `video.vibrance` | core |  |  |

## filter  (10)

| new id | display | ← old id | bundle | gen.cap | note |
|---|---|---|---|---|---|
| `filter.blur.fast` | Fast Blur | `video.fast_blur` | core |  |  |
| `filter.blur.gaussian` | Blur | `video.blur` | core |  |  |
| `filter.edges` | Edges | `video.edges` | core |  | was "Edge Detection" |
| `filter.glitch.block_dehance` | Block Dehance | `fx.block_dehance` | lights |  |  |
| `filter.glitch.twitch_mask` | Twitch Mask | `video.twitch_mask` | core |  |  |
| `filter.height_from_gradient` | Height From Gradient | `video.height_from_gradient` | nano |  | JUDGMENT: GPU field utility |
| `filter.light.flicker_grid` | Flicker Grid |  | lights |  | per-column luma→flicker-rate LED grid |
| `filter.lights_sim` | Lights Sim | `fx.lights_sim` | lights |  | JUDGMENT: input->LED-bar sampler |
| `filter.sharpen` | Sharpen | `video.sharpen` | core |  |  |
| `filter.vignette` | Vignette | `video.vignette` | core |  |  |

## warp  (3)

| new id | display | ← old id | bundle | gen.cap | note |
|---|---|---|---|---|---|
| `warp.crop` | Crop | `video.crop` | core |  |  |
| `warp.dispersion` | Dispersion | `fx.dispersion` | lights |  |  |
| `warp.transform` | Transform | `video.transform` | core |  |  |

## composite  (2)

| new id | display | ← old id | bundle | gen.cap | note |
|---|---|---|---|---|---|
| `composite.bake_alpha` | Bake Alpha | `video.bake_alpha` | core |  |  |
| `composite.blend` | Blend | `video.blend` | core,testonly |  | drop "Video" |

## motion  (3)

| new id | display | ← old id | bundle | gen.cap | note |
|---|---|---|---|---|---|
| `motion.blur` | Motion Blur | `video.motion_blur` | core,testonly |  |  |
| `motion.field` | Motion Field | `video.motion_field` | nano |  |  |
| `motion.local_delay` | Local Delay | `video.local_delay` | nano |  | JUDGMENT: motion-driven delay |

## mod  (8)

| new id | display | ← old id | bundle | gen.cap | note |
|---|---|---|---|---|---|
| `mod.shaper.delay` | Delay | `mod.delay` | core,testonly |  | shortened display |
| `mod.shaper.envelope` | Envelope | `mod.envelope` | core,testonly |  | shortened display |
| `mod.shaper.remap` | Remap | `mod.remap` | core,testonly |  | shortened display |
| `mod.shaper.smooth` | Smooth | `mod.smooth` | core,testonly |  | shortened display |
| `mod.shaper.spectral` | Spectral Curve | `mod.spectral` | nano |  |  |
| `mod.source.adsr` | ADSR | `data.adsr` | core,testonly |  |  |
| `mod.source.lfo` | LFO | `data.lfo` | core,testonly |  |  |
| `mod.source.spectral_lfo` | Spectral LFO | `data.spectral_lfo` | nano |  |  |

## control  (3)

| new id | display | ← old id | bundle | gen.cap | note |
|---|---|---|---|---|---|
| `control.barrel_macros` | Barrel Macros | `io.barrel_macros` | core |  |  |
| `control.nanolooper` | Nano Looper | `sequencer.nanolooper` | nano |  |  |
| `control.paramlinker` | Param Linker | `utility.paramlinker` | core |  |  |

## debug  (17)

| new id | display | ← old id | bundle | gen.cap | note |
|---|---|---|---|---|---|
| `debug.atomic_test` | Atomic Histogram | `debug.atomic_test` | testonly |  |  |
| `debug.clear_copy_test` | Clear + Copy | `debug.clear_copy_test` | testonly |  |  |
| `debug.fuse_add` | Fuse Add | `debug.fuse_add` | testonly |  | drop "(test)" |
| `debug.fuse_mul` | Fuse Mul | `debug.fuse_mul` | testonly |  | drop "(test)" |
| `debug.fuse_solid` | Fuse Solid | `debug.fuse_solid` | testonly |  | drop "(test)" |
| `debug.gpu_test` | GPU Test | `debug.gpu_test` | testonly |  |  |
| `debug.hdr_test` | HDR Round Trip | `debug.hdr_test` | testonly |  |  |
| `debug.lut3d_test` | 3D LUT | `debug.lut3d_test` | testonly |  |  |
| `debug.motion_rect` | Motion Rect | `debug.motion_rect` | testonly |  |  |
| `debug.motion_static` | Motion Static | `debug.motion_static` | testonly |  |  |
| `debug.motion_swarm` | Motion Swarm | `debug.motion_swarm` | testonly |  |  |
| `debug.mrt_test` | Multi-Render Target | `debug.mrt_test` | testonly |  |  |
| `debug.particles_emitter` | Particles Emitter | `data.particles_emitter` | testonly |  |  |
| `debug.particles_renderer` | Particles Renderer | `video.particles_renderer` | testonly |  |  |
| `debug.rw_storage_test` | RW Storage | `debug.rw_storage_test` | testonly |  |  |
| `debug.spinningtris` | Spinning Triangles | `generator.spinningtris` | testonly | Y |  |
| `debug.trap_test` | Trap Test | `debug.trap_test` | testonly |  |  |
