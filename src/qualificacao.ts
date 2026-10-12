// Qualificação determinística: barata, explicável e sem IA. Cada sinal que pesou vai junto,
// para a pessoa entender no CSV por que o perfil passou ou não.

import type { Config } from "./config.ts";

export type PerfilParaNota = {
  usuario: string;
  nome: string | null;
  bio: string | null;
  comercial: boolean;
  seguidores: number | null;
  posts: number | null;
  linkExterno: string | null;
  legendas: string[];
};

export type Nota = { nota: number; sinais: string[]; eliminado: boolean };

/** Minúsculo e sem acento: "Clínica" casa com "clinica". */
export function normalizar(texto: string | null | undefined): string {
  return (texto ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const TELEFONE = /\(?\d{2}\)?\s?9?\d{4}[-\s.]?\d{4}/;

export function preNota(perfil: PerfilParaNota, criterios: Config["qualificacao"]): Nota {
  const nome = normalizar(`${perfil.usuario} ${perfil.nome ?? ""}`);
  const bio = normalizar(perfil.bio);
  const legendas = normalizar(perfil.legendas.join(" "));
  const tudo = `${nome} ${bio} ${legendas}`;

  const negativa = criterios.palavras_negativas.map(normalizar).find((p) => p && tudo.includes(p));
  if (negativa) return { nota: 0, sinais: [`palavra_negativa:${negativa}`], eliminado: true };
  if (perfil.seguidores !== null && perfil.seguidores < criterios.seguidores_min) return { nota: 0, sinais: [`poucos_seguidores:${perfil.seguidores}`], eliminado: true };
  if (perfil.seguidores !== null && criterios.seguidores_max !== null && perfil.seguidores > criterios.seguidores_max) return { nota: 0, sinais: [`seguidores_demais:${perfil.seguidores}`], eliminado: true };
  if (perfil.posts !== null && perfil.posts < criterios.posts_min) return { nota: 0, sinais: [`poucos_posts:${perfil.posts}`], eliminado: true };

  const chaves = criterios.palavras_chave.map(normalizar).filter(Boolean);
  const sinais: string[] = [];
  let nota = 0;
  const noNome = chaves.find((p) => nome.includes(p));
  if (noNome) {
    nota += 30;
    sinais.push(`palavra_no_nome:${noNome}`);
  }
  const naBio = chaves.find((p) => bio.includes(p));
  if (naBio) {
    nota += 30;
    sinais.push(`palavra_na_bio:${naBio}`);
  }
  const nosPosts = chaves.find((p) => legendas.includes(p));
  if (nosPosts) {
    nota += 15;
    sinais.push(`palavra_nos_posts:${nosPosts}`);
  }
  const comercio = [perfil.comercial && "conta_comercial", perfil.linkExterno && "link_na_bio", (TELEFONE.test(perfil.bio ?? "") || bio.includes("whats")) && "contato_na_bio"].filter(Boolean) as string[];
  if (comercio.length > 0) {
    // Um sinal sozinho é fraco (todo mundo tem link na bio): vale metade.
    nota += comercio.length >= 2 ? 25 : 13;
    sinais.push(...comercio);
  }
  return { nota: Math.min(100, nota), sinais, eliminado: false };
}

export type ClassificacaoIA = { encaixe: number; motivo: string };

/** Nota final: com IA, média da pré-nota e do encaixe da IA; eliminado nunca volta. */
export function notaFinal(pre: Nota, ia: ClassificacaoIA | null): number {
  if (pre.eliminado) return 0;
  if (!ia) return pre.nota;
  return Math.round((pre.nota + Math.min(100, Math.max(0, ia.encaixe))) / 2);
}

const MENCAO_DE_CARGO = /(ceo|dono|dona|propriet[áa]ri[oa]|fundador[a]?|founder|diretor[a]?|s[óo]ci[oa]|gestor[a]?|owner|instagram pessoal|perfil pessoal)\s*[:|\-\u2013]?\s*@([a-z0-9._]{1,30})/giu;

/**
 * "CEO: @fulano", "Perfil pessoal: @fulana": a própria empresa diz quem decide. Só vale @ precedido
 * de cargo; @ de parceiro solto na bio não conta.
 */
export function mencoesDeDono(bio: string | null, usuarioDaEmpresa: string): Array<{ usuario: string; cargo: string }> {
  const achadas: Array<{ usuario: string; cargo: string }> = [];
  for (const m of (bio ?? "").matchAll(MENCAO_DE_CARGO)) {
    const usuario = (m[2] ?? "").toLowerCase().replace(/\.$/, "");
    if (!usuario || usuario === usuarioDaEmpresa.toLowerCase() || achadas.some((a) => a.usuario === usuario)) continue;
    achadas.push({ usuario, cargo: (m[1] ?? "").toLowerCase() });
  }
  return achadas;
}
