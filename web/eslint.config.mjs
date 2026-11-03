import { registerHooks } from "node:module";
import { defineConfig, globalIgnores } from "eslint/config";

// typescript-eslint parses with the TypeScript 6 API, which TypeScript 7 (used
// by tsc and next build) no longer ships; point its import at the side-by-side
// TypeScript 6 package.
registerHooks({
  resolve: (specifier, context, nextResolve) =>
    nextResolve(
      specifier === "typescript" ? "@typescript/typescript6" : specifier,
      context,
    ),
});
const { default: nextVitals } =
  await import("eslint-config-next/core-web-vitals");
const { default: nextTypeScript } =
  await import("eslint-config-next/typescript");

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  globalIgnores([
    ".next/**",
    "next-env.d.ts",
    "playwright-report/**",
    "test-results/**",
  ]),
]);
