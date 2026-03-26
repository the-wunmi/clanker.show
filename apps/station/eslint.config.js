import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/server/mcp.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["*eleven*", "*Eleven*"], message: "Not allowed in mcp.ts." },
          ],
        },
      ],
    },
  },
  {
    ignores: ["src/generated/**", "dist/**"],
  },
);
