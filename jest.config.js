module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/app/'],
  collectCoverageFrom: ['lib/**/*.{ts,tsx}', 'utils/**/*.{ts,tsx}', 'store/**/*.{ts,tsx}'],
};
