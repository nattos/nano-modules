// Perf regression suite — MANUAL. These scenarios do realtime decode work and
// gate on committed per-backend baselines, so they're excluded from the default
// e2e run (jest.config.js ignores test/perf) and invoked explicitly:
//
//   GPU_TEST_BASE_URL=http://localhost:5173 npx jest --config jest.perf.config.js
//   UPDATE_BASELINES=1 GPU_TEST_BASE_URL=http://localhost:5173 npx jest --config jest.perf.config.js
//
// --runInBand by default: two backends contending for the same GPU would make
// the wall-clock metrics meaningless.
module.exports = {
  preset: 'jest-puppeteer',
  transform: {
    '^.+\\.tsx?$': 'babel-jest',
  },
  testMatch: ['**/test/perf/**/*.test.ts'],
  maxWorkers: 1,
};
