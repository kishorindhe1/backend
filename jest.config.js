/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots:           ['<rootDir>/src/__tests__'],
  testMatch:       ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig:         '<rootDir>/tsconfig.json',  // use project config
      isolatedModules:  true,                        // skip type-checking in transform = fast
      diagnostics:      false,                       // disable ts-jest type errors (tsc handles them)
    }],
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/__tests__/**',
    '!src/migrations/**',
    '!src/seeders/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  testTimeout:       30000,
  forceExit:         true,
};
