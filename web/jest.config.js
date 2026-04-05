module.exports = {
  preset: 'jest-puppeteer',
  transform: {
    '^.+\\.tsx?$': 'babel-jest',
  },
  testMatch: ['**/test/**/*.test.ts'],
};
