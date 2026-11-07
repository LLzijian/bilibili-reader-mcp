import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Agent worktrees live beneath .claude/; only this checkout's tests
    // may run, especially smoke tests that build this checkout's dist/.
    include: ["tests/**/*.test.ts"],
  },
});
