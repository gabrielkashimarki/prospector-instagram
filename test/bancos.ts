// Os testes de banco rodam nos dois dialetos. Postgres só quando TEST_DATABASE_URL existe
// (ex.: docker run -e POSTGRES_PASSWORD=teste -p 127.0.0.1:54329:5432 postgres:17-alpine).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abrirPostgres, abrirSqlite, type Banco, migrar } from "../src/db.ts";

export type Fabrica = { nome: string; abrir: () => Promise<{ db: Banco; outraConexao: () => Promise<Banco> }> };

const url = process.env.TEST_DATABASE_URL;

export const DIALETOS: Fabrica[] = [
  {
    nome: "sqlite",
    abrir: async () => {
      const arquivo = join(mkdtempSync(join(tmpdir(), "prospector-")), "teste.db");
      const db = abrirSqlite(arquivo);
      await migrar(db);
      return { db, outraConexao: async () => abrirSqlite(arquivo) };
    },
  },
  ...(url
    ? [
        {
          nome: "postgres",
          abrir: async () => {
            const db = await abrirPostgres(url);
            await db.todos("drop schema public cascade");
            await db.todos("create schema public");
            await migrar(db);
            return { db, outraConexao: () => abrirPostgres(url) };
          },
        },
      ]
    : []),
];
