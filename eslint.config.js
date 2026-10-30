import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["node_modules/", "data/", "coverage/"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // Express needs all four parameters to recognise an error handler: allow _unused ones.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
);
