const path = require('path');

// The extras' own e2e suites (nano-modules-extras/tests/web) run on this
// harness when NANO_EXTRAS_DIR names a checkout — and only then:
//
//   NANO_EXTRAS_DIR=../../nano-modules-extras GPU_TEST_BASE_URL=... npx jest
//
// They import our helpers as `@nano/web/test/gpu-test-helpers` (and anything
// else under web/ as `@nano/web/...`), and resolve packages from our
// node_modules, since the extras checkout has none.
const extras = process.env.NANO_EXTRAS_DIR
  ? path.resolve(process.env.NANO_EXTRAS_DIR)
  : null;

module.exports = {
  preset: 'jest-puppeteer',
  rootDir: __dirname,
  roots: ['<rootDir>', ...(extras ? [path.join(extras, 'tests', 'web')] : [])],
  modulePaths: ['<rootDir>/node_modules'],
  moduleNameMapper: {
    '^@nano/web/(.*)$': '<rootDir>/$1',
  },
  transform: {
    // An explicit config file, so suites outside web/ compile the same way.
    '^.+\\.tsx?$': ['babel-jest', { configFile: path.join(__dirname, 'babel.config.js') }],
  },
  testMatch: [
    '**/test/**/*.test.ts',
    ...(extras ? ['**/tests/web/**/*.test.ts'] : []),
  ],
  // The perf regression suite is realtime work gated on committed baselines —
  // manual only, via jest.perf.config.js.
  testPathIgnorePatterns: ['/node_modules/', '/test/perf/'],
};
