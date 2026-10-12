import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules", "dados", "exportacoes", "supabase/functions/receber-webhook/index.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { console: "readonly", process: "readonly", fetch: "readonly", URL: "readonly", Buffer: "readonly", setTimeout: "readonly", AbortSignal: "readonly", TextEncoder: "readonly", crypto: "readonly", Request: "readonly", Response: "readonly" } } },
);
