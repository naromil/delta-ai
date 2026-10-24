import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Tests import renderer .tsx modules (react-jsx), so esbuild needs the
  // automatic runtime even though the test files themselves are plain .ts.
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node'
  }
})
