import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    // Build artifacts, matched at ANY depth. The bare `.next/**` these replace only matched at the
    // repo root, so a nested checkout's artifacts were linted as if they were source — which is how
    // `webpack-runtime.js` and `webpack.js` came to report no-assign-module-variable errors that no
    // hand-written file causes.
    ignores: [
      "**/.next/**",
      "**/.next-dev/**",
      "**/.open-next/**",
      "**/.wrangler/**",
      "**/node_modules/**",
      "backend/**",
      // Claude Code worktrees are FULL separate checkouts of this repo sitting inside it, each on
      // its own branch and each carrying its own eslint.config.mjs. Linting them from here ran the
      // parent branch's rules over another branch's source (118 duplicate src/ files, 67% of
      // everything linted) and reported the results as if they belonged to the current tree.
      // Already ignored by .gitignore (c434c13); this is the same call for lint.
      ".claude/worktrees/**",
    ],
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
