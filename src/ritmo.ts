// Ritmo da conta: janela de horário, limites por hora e por dia de cada ação, intervalo mínimo
// sorteado entre ações do mesmo tipo e aquecimento das DMs. Tudo por operador (conta do Instagram).

import type { Config } from "./config.ts";
import { type Banco, gravarEstado, lerEstado, um } from "./db.ts";

export type Acao = "dm" | "curtida" | "leitura" | "busca";
export type Janela = Config["janela"];
export type Limites = Config["limites"];

export function sortear(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** Data, minuto do dia e dia da semana no fuso da janela. */
export function partesLocais(data: Date, fuso: string): { dia: string; minutos: number; diaSemana: Janela["dias"][number] } {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: fuso, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" })
      .formatToParts(data)
      .map((p) => [p.type, p.value]),
  );
  const semana = { Sun: "dom", Mon: "seg", Tue: "ter", Wed: "qua", Thu: "qui", Fri: "sex", Sat: "sab" } as const;
  return {
    dia: `${partes.year}-${partes.month}-${partes.day}`,
    minutos: Number(partes.hour) * 60 + Number(partes.minute),
    diaSemana: semana[partes.weekday as keyof typeof semana],
  };
}

function minutosDe(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
}

/** Janela com início depois do fim atravessa a meia-noite (ex.: 22:00 a 02:00). */
export function dentroDaJanela(data: Date, janela: Janela): boolean {
  const { minutos, diaSemana } = partesLocais(data, janela.fuso);
  if (!janela.dias.includes(diaSemana)) return false;
  const inicio = minutosDe(janela.inicio);
  const fim = minutosDe(janela.fim);
  return inicio <= fim ? minutos >= inicio && minutos < fim : minutos >= inicio || minutos < fim;
}

/**
 * Próximo minuto dentro da janela. `outroDia` pula o resto de hoje (limite diário batido).
 * Anda de minuto em minuto por até 8 dias: simples e imune a horário de verão.
 */
export function proximaAbertura(data: Date, janela: Janela, outroDia = false): Date {
  const hoje = partesLocais(data, janela.fuso).dia;
  const cursor = new Date(Math.floor(data.getTime() / 60_000) * 60_000);
  for (let i = 0; i < 8 * 24 * 60; i += 1) {
    cursor.setTime(cursor.getTime() + 60_000);
    if (outroDia && partesLocais(cursor, janela.fuso).dia === hoje) continue;
    if (dentroDaJanela(cursor, janela)) return cursor;
  }
  throw new Error("A janela de horário não abre nenhuma vez em 8 dias. Confira janela.dias, inicio e fim.");
}

/** DMs liberadas por dia na semana atual do aquecimento, sem passar do limite configurado. */
export function tetoDeDmHoje(limites: Limites, inicioAquecimento: string | null, momento: Date): number {
  const semanas = inicioAquecimento ? Math.floor((momento.getTime() - new Date(inicioAquecimento).getTime()) / (7 * 86_400_000)) : 0;
  const aquecimento = limites.aquecimento.dm_por_dia_inicial + limites.aquecimento.aumento_por_semana * Math.max(0, semanas);
  return Math.min(limites.dm.por_dia, aquecimento);
}

export type Liberacao = { ok: true } | { ok: false; motivo: string; esperarSegundos: number };

/** Pode fazer esta ação agora? Ordem: janela, teto do dia, teto da hora, intervalo mínimo. */
export async function liberacao(db: Banco, config: Config, operador: string, acao: Acao, momento = new Date()): Promise<Liberacao> {
  const { janela, limites } = config;
  const segundosAte = (data: Date) => Math.max(1, Math.ceil((data.getTime() - momento.getTime()) / 1000));
  if (!dentroDaJanela(momento, janela)) return { ok: false, motivo: "fora da janela de horário", esperarSegundos: segundosAte(proximaAbertura(momento, janela)) };

  const dia = partesLocais(momento, janela.fuso).dia;
  const teto = acao === "dm" ? tetoDeDmHoje(limites, await lerEstado<string>(db, `aquecimento_inicio:${operador}`), momento) : limites[acao].por_dia;
  const hoje = await um<{ n: unknown }>(db, "select cast(count(*) as integer) as n from acoes where operador = ? and tipo = ? and dia = ?", [operador, acao, dia]);
  if (Number(hoje?.n ?? 0) >= teto) return { ok: false, motivo: `limite diário de ${acao} (${teto})`, esperarSegundos: segundosAte(proximaAbertura(momento, janela, true)) };

  const umaHoraAtras = new Date(momento.getTime() - 3_600_000).toISOString();
  const hora = await um<{ n: unknown; primeira: string | null }>(db, "select cast(count(*) as integer) as n, min(criado_em) as primeira from acoes where operador = ? and tipo = ? and criado_em > ?", [operador, acao, umaHoraAtras]);
  if (Number(hora?.n ?? 0) >= limites[acao].por_hora && hora?.primeira) {
    return { ok: false, motivo: `limite por hora de ${acao} (${limites[acao].por_hora})`, esperarSegundos: segundosAte(new Date(new Date(hora.primeira).getTime() + 3_600_000)) };
  }

  const proxima = await lerEstado<string>(db, `proxima:${operador}:${acao}`);
  if (proxima && new Date(proxima) > momento) return { ok: false, motivo: `intervalo mínimo entre ${acao}`, esperarSegundos: segundosAte(new Date(proxima)) };
  return { ok: true };
}

/** Registra a ação feita e sorteia quando a próxima do mesmo tipo pode sair. */
export async function registrarAcao(db: Banco, config: Config, operador: string, acao: Acao, momento = new Date()): Promise<void> {
  const [min, max] = config.limites[acao].intervalo_segundos;
  await db.todos("insert into acoes (operador, tipo, dia, criado_em) values (?, ?, ?, ?)", [operador, acao, partesLocais(momento, config.janela.fuso).dia, momento.toISOString()]);
  await gravarEstado(db, `proxima:${operador}:${acao}`, new Date(momento.getTime() + sortear(min, max) * 1000).toISOString());
  if (acao === "dm" && !(await lerEstado(db, `aquecimento_inicio:${operador}`))) await gravarEstado(db, `aquecimento_inicio:${operador}`, momento.toISOString());
}

export async function acoesDeHoje(db: Banco, config: Config, operador: string, momento = new Date()): Promise<Record<string, number>> {
  const dia = partesLocais(momento, config.janela.fuso).dia;
  const linhas = await db.todos<{ tipo: string; n: unknown }>("select tipo, cast(count(*) as integer) as n from acoes where operador = ? and dia = ? group by tipo", [operador, dia]);
  return Object.fromEntries(linhas.map((l) => [l.tipo, Number(l.n)]));
}

