import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

// Equivalent to the former .eslintrc.json (`extends: ["next/core-web-vitals"]`
// plus ignorePatterns). Uses eslint-config-next's native ESLint 9 flat export
// rather than adding next/typescript, which was never enabled before.
// eslint-config-next 16 ships React Compiler hook rules that were not in the
// previous 15.x core-web-vitals set; leave them off so this is a config-only
// bump with equivalent lint, not a product rewrite.
const eslintConfig = defineConfig([
  ...nextVitals,
  {
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/purity": "off",
      "react-hooks/preserve-manual-memoization": "off",
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".claude/**",
    "node_modules/**",
    "public/**",
  ]),
]);

export default eslintConfig;
