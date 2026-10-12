import { defineConfig } from "vitest/config";

// Um arquivo de teste por vez: os testes de Postgres usam o mesmo banco descartável.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], fileParallelism: false } });
