import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { validarConfig, type Config } from "../src/config.ts";
import type { Banco } from "../src/db.ts";
import { dentroDaJanela, liberacao, partesLocais, proximaAbertura, registrarAcao, tetoDeDmHoje, type Janela } from "../src/ritmo.ts";
import { DIALETOS } from "./bancos.ts";

const base = validarConfig(parse(readFileSync(new URL("../config.example.yaml", import.meta.url), "utf8")));
const janela: Janela = { inicio: "09:00", fim: "18:00", dias: ["seg", "ter", "qua", "qui", "sex"], fuso: "America/Sao_Paulo" };
// São Paulo é UTC-3 o ano todo: 12:00Z = 09:00 local.
const em = (iso: string) => new Date(iso);

describe("janela de horário", () => {
  it("respeita início, fim e dias da semana no fuso", () => {
    expect(dentroDaJanela(em("2026-10-12T12:00:00Z"), janela)).toBe(true); // segunda 09:00
    expect(dentroDaJanela(em("2026-10-12T11:59:00Z"), janela)).toBe(false); // 08:59
    expect(dentroDaJanela(em("2026-10-12T21:00:00Z"), janela)).toBe(false); // 18:00 já fechou
    expect(dentroDaJanela(em("2026-10-11T15:00:00Z"), janela)).toBe(false); // domingo
  });

  it("janela que passa da meia-noite", () => {
    const noite: Janela = { ...janela, inicio: "22:00", fim: "02:00", dias: ["seg", "ter", "qua", "qui", "sex", "sab", "dom"] };
    expect(dentroDaJanela(em("2026-10-13T02:30:00Z"), noite)).toBe(true); // 23:30
    expect(dentroDaJanela(em("2026-10-13T04:30:00Z"), noite)).toBe(true); // 01:30
    expect(dentroDaJanela(em("2026-10-13T06:00:00Z"), noite)).toBe(false); // 03:00
  });

  it("próxima abertura pula o fim de semana e, com outroDia, o resto de hoje", () => {
    expect(proximaAbertura(em("2026-10-16T22:00:00Z"), janela).toISOString()).toBe("2026-10-19T12:00:00.000Z"); // sexta 19h → segunda 9h
    expect(proximaAbertura(em("2026-10-13T15:00:00Z"), janela, true).toISOString()).toBe("2026-10-14T12:00:00.000Z");
    expect(partesLocais(em("2026-10-13T02:30:00Z"), "America/Sao_Paulo")).toEqual({ dia: "2026-10-12", minutos: 23 * 60 + 30, diaSemana: "seg" });
  });

  it("janela que nunca abre avisa em vez de travar", () => {
    expect(() => proximaAbertura(em("2026-10-12T12:00:00Z"), { ...janela, inicio: "10:00", fim: "10:00" })).toThrow(/não abre/);
  });
});

describe("aquecimento das DMs", () => {
  it("começa baixo e sobe por semana até o limite", () => {
    const limites = { ...base.limites, dm: { ...base.limites.dm, por_dia: 12 }, aquecimento: { dm_por_dia_inicial: 5, aumento_por_semana: 5 } };
    expect(tetoDeDmHoje(limites, null, em("2026-10-12T12:00:00Z"))).toBe(5);
    expect(tetoDeDmHoje(limites, "2026-10-01T12:00:00Z", em("2026-10-12T12:00:00Z"))).toBe(10);
    expect(tetoDeDmHoje(limites, "2026-08-01T12:00:00Z", em("2026-10-12T12:00:00Z"))).toBe(12);
  });
});

describe.each(DIALETOS)("limites por operador ($nome)", ({ abrir }) => {
  let db: Banco;
  beforeEach(async () => ({ db } = await abrir()));
  afterEach(async () => db.fechar());

  const config: Config = {
    ...base,
    janela,
    limites: { ...base.limites, curtida: { por_dia: 3, por_hora: 2, intervalo_segundos: [60, 60] } },
  };

  it("fora da janela espera a abertura", async () => {
    const r = await liberacao(db, config, "eu", "curtida", em("2026-10-12T11:00:00Z"));
    expect(r).toEqual({ ok: false, motivo: "fora da janela de horário", esperarSegundos: 3600 });
  });

  it("intervalo mínimo, teto por hora e teto do dia, separados por operador", async () => {
    const t0 = em("2026-10-12T13:00:00Z");
    expect((await liberacao(db, config, "eu", "curtida", t0)).ok).toBe(true);
    await registrarAcao(db, config, "eu", "curtida", t0);
    expect(await liberacao(db, config, "eu", "curtida", em("2026-10-12T13:00:30Z"))).toMatchObject({ ok: false, esperarSegundos: 30 });
    expect((await liberacao(db, config, "outra", "curtida", em("2026-10-12T13:00:30Z"))).ok).toBe(true);
    await registrarAcao(db, config, "eu", "curtida", em("2026-10-12T13:02:00Z"));
    const hora = await liberacao(db, config, "eu", "curtida", em("2026-10-12T13:10:00Z"));
    expect(hora).toMatchObject({ ok: false, esperarSegundos: 50 * 60 });
    await registrarAcao(db, config, "eu", "curtida", em("2026-10-12T15:00:00Z"));
    const dia = await liberacao(db, config, "eu", "curtida", em("2026-10-12T17:00:00Z"));
    expect(dia).toMatchObject({ ok: false, motivo: "limite diário de curtida (3)" });
    expect(dia.ok === false && dia.esperarSegundos).toBe(19 * 3600); // 14h local → 9h de amanhã
  });

  it("a primeira DM liga o relógio do aquecimento", async () => {
    const t0 = em("2026-10-12T13:00:00Z");
    await registrarAcao(db, config, "eu", "dm", t0);
    for (let i = 1; i < 5; i += 1) await registrarAcao(db, config, "eu", "dm", new Date(t0.getTime() + i * 1000));
    const r = await liberacao(db, { ...config, limites: { ...config.limites, dm: { ...config.limites.dm, por_hora: 99, intervalo_segundos: [0, 0] } } }, "eu", "dm", em("2026-10-12T14:30:00Z"));
    expect(r).toMatchObject({ ok: false, motivo: "limite diário de dm (5)" });
  });
});
