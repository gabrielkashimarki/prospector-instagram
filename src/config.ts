// Lê o .env (segredos) e o config.yaml (tudo o mais). O config é validado aqui: valor errado para
// com uma mensagem que diz qual campo corrigir, em vez de quebrar no meio da prospecção.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const intervalo = z.tuple([z.number().nonnegative(), z.number().nonnegative()]).refine(([a, b]) => a <= b, "o primeiro número precisa ser menor ou igual ao segundo");
const limite = z.object({ por_dia: z.number().int().nonnegative(), por_hora: z.number().int().nonnegative(), intervalo_segundos: intervalo });
const hora = z.string().regex(/^\d{2}:\d{2}$/, 'use o formato "HH:MM"');
const DIAS = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"] as const;

export const esquemaConfig = z.object({
  nicho: z.string().min(1),
  operador: z.object({
    nome: z.string().min(1),
    instagram: z.string().min(1).transform((v) => v.trim().replace(/^@/, "").toLowerCase()),
  }),
  descoberta: z.object({
    buscas: z.array(z.string()).default([]),
    hashtags: z.array(z.string()).default([]),
    perfis: z.array(z.string()).default([]),
    max_perfis_por_busca: z.number().int().positive().default(20),
    nunca_contatar: z.array(z.string()).default([]),
  }),
  qualificacao: z.object({
    palavras_chave: z.array(z.string()).default([]),
    palavras_negativas: z.array(z.string()).default([]),
    seguidores_min: z.number().int().nonnegative().default(0),
    seguidores_max: z.number().int().positive().nullable().default(null),
    posts_min: z.number().int().nonnegative().default(0),
    pontuacao_minima: z.number().int().min(0).max(100).default(60),
    usar_ia: z.boolean().default(true),
    cliente_ideal: z.string().default(""),
  }),
  dono: z.object({ buscar_na_bio: z.boolean().default(true) }).default({ buscar_na_bio: true }),
  mensagem: z.object({
    remetente: z.string().min(1),
    empresa: z.string().default(""),
    oferta: z.string().min(1),
    objetivo: z.string().min(1),
    tom: z.string().min(1),
    regras: z.array(z.string()).default([]),
    max_caracteres: z.number().int().positive().max(1000).default(350),
  }),
  modo: z.enum(["rascunho", "envio"]).default("rascunho"),
  curtir_antes_da_dm: z.boolean().default(false),
  seguimento: z.object({ ativo: z.boolean().default(false), dias: z.number().positive().default(3), maximo: z.number().int().min(0).max(3).default(1) }),
  limites: z.object({
    dm: limite,
    curtida: limite,
    leitura: limite,
    busca: limite,
    aquecimento: z.object({ dm_por_dia_inicial: z.number().int().positive(), aumento_por_semana: z.number().int().nonnegative() }),
    falhas_por_hora: z.number().int().positive().default(8),
  }),
  janela: z.object({
    inicio: hora,
    fim: hora,
    dias: z.array(z.enum(DIAS)).min(1),
    fuso: z.string().refine((fuso) => {
      try {
        new Intl.DateTimeFormat("pt-BR", { timeZone: fuso });
        return true;
      } catch {
        return false;
      }
    }, "fuso horário desconhecido (exemplo: America/Sao_Paulo)"),
  }),
  pausas: z.object({
    entre_acoes_segundos: intervalo,
    pausa_longa: z.object({ a_cada_acoes: z.number().int().positive(), minutos: intervalo }),
  }),
  ia: z.object({
    provedor: z.enum(["anthropic", "openai", "openrouter"]),
    modelo: z.string().min(1),
    preco_entrada_por_milhao: z.number().nonnegative(),
    preco_saida_por_milhao: z.number().nonnegative(),
    teto_diario_usd: z.number().positive(),
  }),
  caixa: z.object({
    provedor: z.enum(["nenhum", "zernio", "meta"]).default("nenhum"),
    sincronizar_a_cada_minutos: z.number().int().min(1).default(5),
    respostas: z.enum(["desligado", "rascunho", "automatico"]).default("rascunho"),
    zernio_conta: z.string().default(""),
    receber: z.enum(["sincronizacao", "webhook_supabase"]).default("sincronizacao"),
  }),
  chrome: z.object({
    porta: z.number().int().default(9333),
    perfil: z.string().default("./dados/chrome-perfil"),
    reiniciar_a_cada_jobs: z.number().int().nonnegative().default(150),
  }),
  banco: z.object({ arquivo: z.string().default("./dados/prospector.db") }).default({ arquivo: "./dados/prospector.db" }),
});

export type Config = z.infer<typeof esquemaConfig>;

export type Segredos = {
  iaChave: string;
  databaseUrl: string | undefined;
  zernioChave: string | undefined;
  metaToken: string | undefined;
};

function vazioViraUndefined(valor: string | undefined): string | undefined {
  return valor?.trim() ? valor.trim() : undefined;
}

export function lerSegredos(env: NodeJS.ProcessEnv = process.env): Segredos {
  return {
    iaChave: env.IA_CHAVE?.trim() ?? "",
    databaseUrl: vazioViraUndefined(env.DATABASE_URL),
    zernioChave: vazioViraUndefined(env.ZERNIO_API_KEY),
    metaToken: vazioViraUndefined(env.META_ACCESS_TOKEN),
  };
}

export function validarConfig(bruto: unknown): Config {
  const resultado = esquemaConfig.safeParse(bruto);
  if (resultado.success) return resultado.data;
  const linhas = resultado.error.issues.map((issue) => `  - ${issue.path.join(".") || "(raiz)"}: ${issue.message}`);
  throw new Error(`O config.yaml tem problemas:\n${linhas.join("\n")}`);
}

export function carregarConfig(pasta = process.cwd()): { config: Config; segredos: Segredos } {
  const env = resolve(pasta, ".env");
  if (existsSync(env)) process.loadEnvFile(env);
  const arquivo = resolve(pasta, "config.yaml");
  if (!existsSync(arquivo)) throw new Error("Não achei o config.yaml. Rode `npm run instalar` primeiro.");
  return { config: validarConfig(parse(readFileSync(arquivo, "utf8"))), segredos: lerSegredos() };
}
