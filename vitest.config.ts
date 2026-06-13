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
      exclude: [
        "**/*.test.ts",
        // VS Code extension host — requires the VS Code runtime; covered by E2E
        "packages/extension/src/extension.ts",
        "packages/extension/src/commands.ts",
        "packages/extension/src/webview/panel.ts",
        // Pure type declaration files — no executable statements
        "packages/extension/src/webview/messages.ts",
        "packages/extension/webview-src/store/view-model.ts",
        // Browser webview entry point and DOM renderers — require DOM; covered by E2E
        "packages/extension/webview-src/app.ts",
        "packages/extension/webview-src/renderer/**",
      ],
      thresholds: {
        lines: COVERAGE_THRESHOLD_PERCENT,
        functions: COVERAGE_THRESHOLD_PERCENT,
        branches: COVERAGE_THRESHOLD_PERCENT,
        statements: COVERAGE_THRESHOLD_PERCENT,
      },
    },
  },
});
