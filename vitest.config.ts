import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

const COVERAGE_THRESHOLD_PERCENT = 80;

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ["./tsconfig.json"] })],
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/webview-src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts", "packages/*/webview-src/**/*.ts"],
      exclude: ["**/*.test.ts"],
      thresholds: {
        lines: COVERAGE_THRESHOLD_PERCENT,
        functions: COVERAGE_THRESHOLD_PERCENT,
        branches: COVERAGE_THRESHOLD_PERCENT,
        statements: COVERAGE_THRESHOLD_PERCENT,
      },
    },
  },
});
