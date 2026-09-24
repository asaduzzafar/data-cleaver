import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// Component tests run in jsdom. Accessibility is checked separately, in a
// real browser (tests/a11y, Playwright): jsdom cannot compute colour contrast.
export default mergeConfig(viteConfig, defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/unit/**/*.test.tsx"],
  },
}));
