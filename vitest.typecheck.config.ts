import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        typecheck: {
            ignoreSourceErrors: true,
            include: ["src/**/*.test-d.ts"],
            tsconfig: "./tsconfig.typecheck.json",
        },
    },
});
