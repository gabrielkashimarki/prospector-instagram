import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { lerSegredos, validarConfig } from "../src/config.ts";
import { celulaCsv, linhasCsv } from "../src/csv.ts";

describe("CSV", () => {
  it("escapa aspas, vírgula e quebra de linha", () => {
    expect(celulaCsv('a "b", c\nd')).toBe('"a ""b"", c\nd"');
    expect(celulaCsv(null)).toBe("");
  });

  it("texto que parece fórmula vira texto puro", () => {
    expect(celulaCsv("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(celulaCsv("+55 11")).toBe("'+55 11");
    expect(celulaCsv("@perfil")).toBe("'@perfil");
  });

  it("marca lead quente e monta o link do perfil", () => {
    const csv = linhasCsv([{ usuario: "lead.um", estado: "quente", respondeu_em: "2026-10-12T00:00:00Z" }]);
    expect(csv.startsWith("﻿usuario,link,estado,lead_quente")).toBe(true);
    expect(csv).toContain("lead.um,https://www.instagram.com/lead.um/,quente,sim");
  });
});

describe("config", () => {
  it("o config de exemplo é válido e começa em modo rascunho", () => {
    const config = validarConfig(parse(readFileSync(new URL("../config.example.yaml", import.meta.url), "utf8")));
    expect(config.modo).toBe("rascunho");
    expect(config.caixa.respostas).toBe("rascunho");
  });

  it("erro de config diz qual campo corrigir", () => {
    const bruto = parse(readFileSync(new URL("../config.example.yaml", import.meta.url), "utf8")) as Record<string, Record<string, unknown>>;
    bruto.janela!.fuso = "Lugar/Nenhum";
    bruto.limites!.dm = { por_dia: 10, por_hora: 2, intervalo_segundos: [600, 60] };
    expect(() => validarConfig(bruto)).toThrow(/limites\.dm\.intervalo_segundos: o primeiro número[\s\S]*janela\.fuso: fuso horário desconhecido/);
  });

  it("segredo vazio no .env vira ausente (SQLite em vez de Postgres)", () => {
    expect(lerSegredos({ DATABASE_URL: "  ", IA_CHAVE: "k" })).toMatchObject({ databaseUrl: undefined, iaChave: "k" });
  });
});
