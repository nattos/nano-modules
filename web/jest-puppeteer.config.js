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

// A dev server reached by LAN address (a remote compositor has to fetch the
// page's media from it: test/comp-backend.ts REMOTE) isn't a secure context
// over plain http, which would cost the page WebGPU. Vouch for that one origin.
const base = process.env.GPU_TEST_BASE_URL;
if (base) {
  const { hostname, origin } = new URL(base);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
    args.push(`--unsafely-treat-insecure-origin-as-secure=${origin}`);
  }
}

module.exports = {
  launch: {
    headless: 'new',
    args,
  },
  browserContext: 'default',
};
