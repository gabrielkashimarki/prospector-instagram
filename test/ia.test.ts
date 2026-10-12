import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { validarConfig } from "../src/config.ts";
import type { Banco, Lead } from "../src/db.ts";
import { chamarIA, ConteudoRecusado, extrairJson, gastoDeHoje, lerClassificacao, promptAbertura, promptClassificacao, promptResposta, type Provedor, TetoDeGastoAtingido, validarMensagem } from "../src/ia.ts";
import { DIALETOS } from "./bancos.ts";

const config = validarConfig(parse(readFileSync(new URL("../config.example.yaml", import.meta.url), "utf8")));

const lead = (extra: Partial<Lead> = {}): Lead => ({
  id: 1,
  usuario: "perfil.exemplo",
  origem: "busca:x",
  estado: "qualificado",
  nome: "Perfil Exemplo",
  bio: "Bio de exemplo",
  seguidores: 1000,
  seguindo: 10,
  posts: 50,
  link_externo: null,
  comercial: 1,
  legendas: JSON.stringify(["legenda um", "legenda dois"]),
  pontuacao: 70,
  motivos: null,
  dono_de: null,
  abertura: null,
  seguimento: null,
  seguimentos: 0,
  operador: null,
  contatado_em: null,
  ultimo_envio_em: null,
  respondeu_em: null,
  ...extra,
});

describe("prompts", () => {
  it("a abertura leva o que a pessoa configurou e só os dados do perfil", () => {
    const p = promptAbertura(config, lead(), null);
    expect(p.system).toContain(config.mensagem.oferta);
    expect(p.system).toContain(config.mensagem.tom);
    expect(p.system).toContain(config.nicho);
    for (const regra of config.mensagem.regras) expect(p.system).toContain(regra);
    expect(p.system).toContain(`${config.mensagem.max_caracteres} caracteres`);
    expect(p.user).toContain("@perfil.exemplo");
    expect(p.user).toContain("Bio: Bio de exemplo");
    expect(p.user).toContain("legenda um | legenda dois");
  });

  it("perfil sem bio não ganha linha de bio vazia (a IA comentaria a ausência)", () => {
    expect(promptAbertura(config, lead({ bio: null }), null).user).not.toContain("Bio:");
  });

  it("abordagem do dono cita a empresa", () => {
    const p = promptAbertura(config, lead({ usuario: "fulana", dono_de: 2 }), lead({ id: 2, usuario: "empresa.exemplo", nome: "Empresa Exemplo" }));
    expect(p.user).toContain("responsável pela empresa @empresa.exemplo (Empresa Exemplo)");
  });

  it("classificação usa o cliente ideal e pede JSON; resposta leva a conversa em ordem", () => {
    expect(promptClassificacao(config, lead()).system).toContain(config.qualificacao.cliente_ideal);
    const r = promptResposta(config, lead(), [{ direcao: "saida", texto: "oi" }, { direcao: "entrada", texto: "olá" }]);
    expect(r.user).toContain("Você: oi\nContato: olá");
  });
});

describe("validação do texto da IA", () => {
  it("tira aspas e recusa vazio, marcador e texto longo demais", () => {
    expect(validarMensagem('"Oi, tudo bem?"', 100)).toBe("Oi, tudo bem?");
    expect(() => validarMensagem("  ", 100)).toThrow(ConteudoRecusado);
    expect(() => validarMensagem("Oi [nome do dono], tudo bem?", 100)).toThrow(/marcador/);
    expect(() => validarMensagem("Oi {{nome}}", 100)).toThrow(/marcador/);
    expect(() => validarMensagem("x".repeat(200), 100)).toThrow(/caracteres/);
  });

  it("lê JSON mesmo embrulhado", () => {
    expect(extrairJson('```json\n{"encaixe": 72, "motivo": "ok"}\n```')).toEqual({ encaixe: 72, motivo: "ok" });
    expect(lerClassificacao('{"encaixe": "80", "motivo": "x"}')).toEqual({ encaixe: 80, motivo: "x" });
    expect(() => lerClassificacao("não sei")).toThrow(ConteudoRecusado);
  });
});

describe.each(DIALETOS)("gasto e cache ($nome)", ({ abrir }) => {
  let db: Banco;
  beforeEach(async () => ({ db } = await abrir()));
  afterEach(async () => db.fechar());

  it("conta tokens e dólares do dia, usa cache só onde pode e para no teto", async () => {
    let chamadas = 0;
    const falso: Provedor = async () => {
      chamadas += 1;
      return { texto: '{"encaixe": 50, "motivo": "ok"}', entrada: 1_000_000, saida: 100_000 };
    };
    const barato = { ...config, ia: { ...config.ia, preco_entrada_por_milhao: 0.1, preco_saida_por_milhao: 0.5, teto_diario_usd: 0.3 } };
    const classificacao = promptClassificacao(barato, lead());
    await chamarIA(db, barato, "chave", "eu", classificacao, falso);
    await chamarIA(db, barato, "chave", "eu", classificacao, falso);
    expect(chamadas).toBe(1);
    const gasto = await gastoDeHoje(db, barato, "eu");
    expect(gasto).toMatchObject({ entrada: 1_000_000, saida: 100_000, chamadas: 1 });
    expect(gasto.usd).toBeCloseTo(0.15, 6);
    const abertura = promptAbertura(barato, lead(), null);
    await chamarIA(db, barato, "chave", "eu", abertura, falso);
    await expect(chamarIA(db, barato, "chave", "eu", abertura, falso)).rejects.toThrow(TetoDeGastoAtingido);
    expect(chamadas).toBe(2);
    expect((await gastoDeHoje(db, barato, "outra")).usd).toBe(0);
  });
});
