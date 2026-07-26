module.exports = {
  preset: 'jest-puppeteer',
  transform: {
    '^.+\\.tsx?$': 'babel-jest',
  },
  testMatch: ['**/test/**/*.test.ts'],
  // The perf regression suite is realtime work gated on committed baselines —
  // manual only, via jest.perf.config.js.
  testPathIgnorePatterns: ['/node_modules/', '/test/perf/'],
};
