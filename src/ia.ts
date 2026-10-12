// IA barata e contada: prompts curtos, cache por conteúdo, gasto do dia gravado no banco e teto
// diário. Três provedores, todos por fetch (sem SDK): Anthropic, OpenAI e OpenRouter.

import { createHash } from "node:crypto";
import type { Config } from "./config.ts";
import { agora, type Banco, type Lead, um } from "./db.ts";
import { partesLocais } from "./ritmo.ts";

export class TetoDeGastoAtingido extends Error {
  constructor(gasto: number, teto: number) {
    super(`Teto diário de IA atingido: US$ ${gasto.toFixed(4)} de US$ ${teto.toFixed(2)}. Volta amanhã ou aumente ia.teto_diario_usd.`);
    this.name = "TetoDeGastoAtingido";
  }
}

export class ConteudoRecusado extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = "ConteudoRecusado";
  }
}

/** `cache` só onde repetir dá a mesma resposta útil (classificação). Texto recusado não pode voltar do cache. */
type Chamada = { system: string; user: string; finalidade: string; maxTokens: number; cache?: boolean };
type Resposta = { texto: string; entrada: number; saida: number };

const TIMEOUT_MS = 60_000;

async function postarJson(url: string, headers: Record<string, string>, corpo: unknown): Promise<Record<string, unknown>> {
  const resposta = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(TIMEOUT_MS) });
  const texto = await resposta.text();
  if (!resposta.ok) throw new Error(`A IA respondeu HTTP ${resposta.status}: ${texto.slice(0, 300)}`);
  return JSON.parse(texto) as Record<string, unknown>;
}

async function chamarProvedor(config: Config, chave: string, c: Chamada): Promise<Resposta> {
  const { provedor, modelo } = config.ia;
  if (provedor === "anthropic") {
    // Esforço baixo: classificar e escrever três linhas não pedem raciocínio longo, e cada token pensado é pago.
    const r = await postarJson(
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": chave, "anthropic-version": "2023-06-01" },
      { model: modelo, max_tokens: c.maxTokens, system: c.system, messages: [{ role: "user", content: c.user }], output_config: { effort: "low" } },
    );
    const blocos = (r.content as Array<{ type: string; text?: string }> | undefined) ?? [];
    const uso = r.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    return { texto: blocos.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim(), entrada: uso?.input_tokens ?? 0, saida: uso?.output_tokens ?? 0 };
  }
  const url = provedor === "openai" ? "https://api.openai.com/v1/chat/completions" : "https://openrouter.ai/api/v1/chat/completions";
  const r = await postarJson(
    url,
    { authorization: `Bearer ${chave}` },
    { model: modelo, max_completion_tokens: c.maxTokens, messages: [{ role: "system", content: c.system }, { role: "user", content: c.user }] },
  );
  const escolha = (r.choices as Array<{ message?: { content?: string } }> | undefined)?.[0];
  const uso = r.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  return { texto: (escolha?.message?.content ?? "").trim(), entrada: uso?.prompt_tokens ?? 0, saida: uso?.completion_tokens ?? 0 };
}

export function custoUsd(config: Config, entrada: number, saida: number): number {
  return (entrada * config.ia.preco_entrada_por_milhao + saida * config.ia.preco_saida_por_milhao) / 1_000_000;
}

export async function gastoDeHoje(db: Banco, config: Config, operador: string, momento = new Date()): Promise<{ usd: number; entrada: number; saida: number; chamadas: number }> {
  const dia = partesLocais(momento, config.janela.fuso).dia;
  const r = await um<{ usd: unknown; entrada: unknown; saida: unknown; chamadas: unknown }>(
    db,
    "select coalesce(sum(custo_usd), 0) as usd, coalesce(sum(entrada), 0) as entrada, coalesce(sum(saida), 0) as saida, cast(count(*) as integer) as chamadas from uso_ia where operador = ? and dia = ?",
    [operador, dia],
  );
  return { usd: Number(r?.usd ?? 0), entrada: Number(r?.entrada ?? 0), saida: Number(r?.saida ?? 0), chamadas: Number(r?.chamadas ?? 0) };
}

export type Provedor = (config: Config, chave: string, c: Chamada) => Promise<Resposta>;

/**
 * Chama a IA com cache (mesmo modelo e mesmo prompt não pagam duas vezes) e teto diário de gasto.
 * `provedor` só é trocado nos testes.
 */
export async function chamarIA(db: Banco, config: Config, chave: string, operador: string, c: Chamada, provedor: Provedor = chamarProvedor): Promise<string> {
  const hash = createHash("sha256").update(JSON.stringify([config.ia.provedor, config.ia.modelo, c.system, c.user])).digest("hex");
  const guardada = c.cache ? await um<{ resposta: string }>(db, "select resposta from cache_ia where hash = ?", [hash]) : undefined;
  if (guardada) return guardada.resposta;
  const gasto = await gastoDeHoje(db, config, operador);
  if (gasto.usd >= config.ia.teto_diario_usd) throw new TetoDeGastoAtingido(gasto.usd, config.ia.teto_diario_usd);
  if (!chave) throw new Error("IA_CHAVE vazia no .env. Rode `npm run instalar` ou preencha o .env.");
  const r = await provedor(config, chave, c);
  const momento = new Date();
  await db.todos("insert into uso_ia (operador, dia, entrada, saida, custo_usd, finalidade, criado_em) values (?, ?, ?, ?, ?, ?, ?)", [
    operador,
    partesLocais(momento, config.janela.fuso).dia,
    r.entrada,
    r.saida,
    custoUsd(config, r.entrada, r.saida),
    c.finalidade,
    momento.toISOString(),
  ]);
  if (c.cache && r.texto) await db.todos("insert into cache_ia (hash, resposta, criado_em) values (?, ?, ?) on conflict (hash) do nothing", [hash, r.texto, agora()]);
  return r.texto;
}

/** Primeiro objeto JSON do texto. Modelos às vezes embrulham em ```json ... ```. */
export function extrairJson(texto: string): Record<string, unknown> {
  const inicio = texto.indexOf("{");
  const fim = texto.lastIndexOf("}");
  if (inicio < 0 || fim <= inicio) throw new ConteudoRecusado(`A IA não devolveu JSON: ${texto.slice(0, 120)}`);
  return JSON.parse(texto.slice(inicio, fim + 1)) as Record<string, unknown>;
}

function resumoDoPerfil(lead: Lead): string {
  const legendas = lead.legendas ? (JSON.parse(lead.legendas) as string[]).slice(0, 3).map((l) => l.slice(0, 160)) : [];
  return [
    `@${lead.usuario}`,
    lead.nome ? `Nome: ${lead.nome}` : null,
    lead.bio ? `Bio: ${lead.bio}` : null,
    lead.seguidores !== null ? `Seguidores: ${lead.seguidores}` : null,
    lead.link_externo ? `Link: ${lead.link_externo}` : null,
    legendas.length ? `Legendas recentes: ${legendas.join(" | ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function promptClassificacao(config: Config, lead: Lead): Chamada {
  return {
    finalidade: "classificar",
    maxTokens: 400,
    cache: true,
    system: [
      `Você avalia perfis públicos do Instagram para prospecção no nicho: ${config.nicho}.`,
      config.qualificacao.cliente_ideal ? `Cliente ideal: ${config.qualificacao.cliente_ideal}` : null,
      'Responda só com JSON: {"encaixe": 0 a 100, "motivo": "uma frase em português"}.',
      "Perfil pessoal sem relação com o nicho fica abaixo de 20.",
    ]
      .filter(Boolean)
      .join("\n"),
    user: resumoDoPerfil(lead),
  };
}

export function lerClassificacao(texto: string): { encaixe: number; motivo: string } {
  const json = extrairJson(texto);
  const encaixe = Number(json.encaixe);
  if (!Number.isFinite(encaixe)) throw new ConteudoRecusado(`Classificação sem encaixe numérico: ${texto.slice(0, 120)}`);
  return { encaixe: Math.round(encaixe), motivo: String(json.motivo ?? "").slice(0, 300) };
}

/** Regras fixas da primeira mensagem. São as que evitam o pior: inventar o que não viu e parecer robô. */
const REGRAS_DA_ABERTURA = [
  "Use só o que está escrito nos dados do perfil. Você não viu fotos, posts, stories nem produtos: nunca cite nada que não esteja ali.",
  "Não escreva \"vi que vocês são a <nome>\" nem comente o próprio perfil. Sem elogio genérico.",
  "Uma pergunta só na mensagem inteira.",
  "Sem marcador para preencher (como [nome]) e sem nota para quem envia.",
];

export function promptAbertura(config: Config, lead: Lead, empresaDoDono: Lead | null): Chamada {
  const m = config.mensagem;
  const alvo = empresaDoDono
    ? `Você está falando com a PESSOA responsável pela empresa @${empresaDoDono.usuario}${empresaDoDono.nome ? ` (${empresaDoDono.nome})` : ""}, no perfil pessoal dela.\n${resumoDoPerfil(lead)}`
    : resumoDoPerfil(lead);
  return {
    finalidade: "abertura",
    maxTokens: 400,
    system: [
      `Você é ${m.remetente}${m.empresa ? `, da ${m.empresa}` : ""}, escrevendo a primeira DM do Instagram para um perfil do nicho: ${config.nicho}.`,
      `O que você oferece (contexto, não precisa dizer tudo): ${m.oferta}`,
      `Objetivo da mensagem: ${m.objetivo}`,
      `Tom: ${m.tom}`,
      ...REGRAS_DA_ABERTURA,
      ...m.regras,
      `No máximo ${m.max_caracteres} caracteres. Responda só com o texto da DM.`,
    ].join("\n"),
    user: alvo,
  };
}

export function promptSeguimento(config: Config, lead: Lead): Chamada {
  const m = config.mensagem;
  return {
    finalidade: "seguimento",
    maxTokens: 300,
    system: [
      `Você é ${m.remetente}. Mandou esta DM há alguns dias e não teve resposta:\n"${lead.abertura ?? ""}"`,
      "Escreva um lembrete curto e gentil, sem repetir a primeira mensagem e sem cobrar resposta.",
      `Tom: ${m.tom}`,
      ...m.regras,
      `No máximo ${Math.min(200, m.max_caracteres)} caracteres. Responda só com o texto.`,
    ].join("\n"),
    user: resumoDoPerfil(lead),
  };
}

export function promptResposta(config: Config, lead: Lead, conversa: Array<{ direcao: string; texto: string }>): Chamada {
  const m = config.mensagem;
  return {
    finalidade: "resposta",
    maxTokens: 500,
    system: [
      `Você é ${m.remetente}${m.empresa ? `, da ${m.empresa}` : ""}, conversando por DM com um contato do nicho ${config.nicho}.`,
      `O que você oferece: ${m.oferta}`,
      `Objetivo: ${m.objetivo}`,
      `Tom: ${m.tom}`,
      ...m.regras,
      "Não invente preço, prazo, resultado nem nada que não esteja acima.",
      'Responda só com JSON: {"acao": "responder" | "encerrar" | "humano", "texto": "a mensagem, quando acao for responder"}.',
      'Use "encerrar" se a pessoa pediu para parar ou não tem interesse, e "humano" se ela pediu algo que só uma pessoa pode resolver.',
    ].join("\n"),
    user: `${resumoDoPerfil(lead)}\n\nConversa até agora (mais antiga primeiro):\n${conversa.map((c) => `${c.direcao === "entrada" ? "Contato" : "Você"}: ${c.texto}`).join("\n")}`,
  };
}

const MARCADOR = /\[[^\]]{2,}\]|\{\{|__[A-Z_]{3,}__|<[a-z_ ]{3,}>/i;

/** Limpa aspas e espaços. Recusa texto vazio, com marcador para preencher ou longo demais. */
export function validarMensagem(texto: string, maxCaracteres: number): string {
  const limpo = texto.trim().replace(/^["“”']+|["“”']+$/g, "").trim();
  if (!limpo) throw new ConteudoRecusado("A IA devolveu mensagem vazia");
  if (MARCADOR.test(limpo)) throw new ConteudoRecusado(`Mensagem com marcador para preencher: ${limpo.slice(0, 120)}`);
  if (limpo.length > maxCaracteres * 1.2) throw new ConteudoRecusado(`Mensagem com ${limpo.length} caracteres, acima de ${maxCaracteres}`);
  return limpo;
}
