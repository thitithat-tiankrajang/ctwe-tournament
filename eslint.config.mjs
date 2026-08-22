import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: [".next/**", ".next-dev/**", ".open-next/**", ".wrangler/**", "node_modules/**", "backend/**"],
  },
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } },
    },
    plugins: { "@next/next": nextPlugin, "react-hooks": reactHooks },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      // A hook placed after an early return runs on some renders and not others, which crashes the
      // whole page with React #310 ("Rendered more hooks than during the previous render"). Neither
      // tsc nor the Next rules can see it, so without this rule the only thing that catches it is a
      // user hitting the crash in production — which is exactly how it happened once already.
      //
      // `exhaustive-deps` stays off deliberately: several effects here carry trimmed dep arrays with
      // a comment explaining why (see card-overview.tsx's forcedKey effect), and warning on every one
      // of them would bury the rule that actually prevents a crash.
      "react-hooks/rules-of-hooks": "error",
    },
  },
];
