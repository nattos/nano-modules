/**
 * Shared WebGPU device acquisition.
 *
 * Every real deployment target (native Metal via the barrel) filters
 * float32 textures; WebGPU is our dev/e2e simulator, and its BASELINE
 * makes rgba32float unfilterable unless 'float32-filterable' is
 * explicitly requested. Request it on every device so effect code never
 * has to design around a capability gap no shipping platform has.
 * Features are still gated on adapter support so an exotic adapter
 * (software fallback, CI oddities) degrades to baseline instead of
 * failing device creation.
 */
export const STANDARD_GPU_FEATURES: GPUFeatureName[] = ['float32-filterable'];

export async function requestStandardDevice(
  adapter: GPUAdapter,
  extra: GPUFeatureName[] = [],
): Promise<GPUDevice> {
  const requiredFeatures = [...STANDARD_GPU_FEATURES, ...extra].filter((f) =>
    adapter.features.has(f),
  );
  return adapter.requestDevice({ requiredFeatures });
}
