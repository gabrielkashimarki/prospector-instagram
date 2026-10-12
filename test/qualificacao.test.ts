import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { validarConfig } from "../src/config.ts";
import { mencoesDeDono, notaFinal, preNota, type PerfilParaNota } from "../src/qualificacao.ts";

const criterios = {
  ...validarConfig(parse(readFileSync(new URL("../config.example.yaml", import.meta.url), "utf8"))).qualificacao,
  palavras_chave: ["clínica", "estética"],
  palavras_negativas: ["curso"],
  seguidores_min: 100,
  seguidores_max: 50_000,
  posts_min: 5,
};

const perfil = (extra: Partial<PerfilParaNota> = {}): PerfilParaNota => ({
  usuario: "clinica.exemplo",
  nome: "Clínica Exemplo",
  bio: "Estética facial e corporal. Agende pelo WhatsApp",
  comercial: true,
  seguidores: 2000,
  posts: 120,
  linkExterno: "https://exemplo.test",
  legendas: ["Resultado de hoje"],
  ...extra,
});

describe("pré-nota", () => {
  it("soma os sinais e explica cada um, sem ligar para acento", () => {
    const n = preNota(perfil(), criterios);
    expect(n.eliminado).toBe(false);
    expect(n.nota).toBe(85);
    expect(n.sinais).toEqual(["palavra_no_nome:clinica", "palavra_na_bio:estetica", "conta_comercial", "link_na_bio", "contato_na_bio"]);
  });

  it("palavra negativa, poucos seguidores, seguidores demais e poucos posts eliminam", () => {
    expect(preNota(perfil({ bio: "Curso de estética" }), criterios)).toMatchObject({ nota: 0, eliminado: true, sinais: ["palavra_negativa:curso"] });
    expect(preNota(perfil({ seguidores: 50 }), criterios).eliminado).toBe(true);
    expect(preNota(perfil({ seguidores: 90_000 }), criterios).eliminado).toBe(true);
    expect(preNota(perfil({ posts: 2 }), criterios).eliminado).toBe(true);
  });

  it("um sinal comercial sozinho vale metade", () => {
    const n = preNota(perfil({ nome: null, usuario: "x", bio: null, comercial: false, legendas: [] }), criterios);
    expect(n.nota).toBe(13);
  });
});

describe("nota final", () => {
  it("média com a IA; eliminado fica em zero", () => {
    expect(notaFinal({ nota: 80, sinais: [], eliminado: false }, { encaixe: 40, motivo: "" })).toBe(60);
    expect(notaFinal({ nota: 80, sinais: [], eliminado: false }, null)).toBe(80);
    expect(notaFinal({ nota: 0, sinais: [], eliminado: true }, { encaixe: 100, motivo: "" })).toBe(0);
  });
});

describe("dono citado na bio", () => {
  it("só @ precedido de cargo conta", () => {
    expect(mencoesDeDono("Loja X | CEO: @fulana.exemplo | parceiros @outra.loja | Perfil pessoal @Ciclano_", "loja.x")).toEqual([
      { usuario: "fulana.exemplo", cargo: "ceo" },
      { usuario: "ciclano_", cargo: "perfil pessoal" },
    ]);
    expect(mencoesDeDono("dono: @loja.x", "loja.x")).toEqual([]);
    expect(mencoesDeDono(null, "x")).toEqual([]);
  });
});
