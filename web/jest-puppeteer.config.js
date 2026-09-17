// Headless Chrome needs WebGPU forced on. `--enable-features=Vulkan` is what
// gets it a real adapter on macOS/Linux; on Windows the default D3D12 backend
// already works and forcing Vulkan can leave `navigator.gpu` with no adapter,
// so drop the flag there.
const args = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--enable-unsafe-webgpu',
];
if (process.platform !== 'win32') args.push('--enable-features=Vulkan');

module.exports = {
  launch: {
    headless: 'new',
    args,
  },
  browserContext: 'default',
};
