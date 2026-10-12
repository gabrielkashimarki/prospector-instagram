// Fila de trabalho no próprio banco. Duas lanes: `navegador` (uma ação por vez no Chrome) e `geral`
// (IA e APIs da caixa de entrada).
// No Postgres, várias máquinas pegam trabalho da mesma fila com `for update skip locked`.

import { agora, type Banco, um } from "./db.ts";

export const LANE_DO_TIPO = {
  descobrir: "navegador",
  ler_perfil: "navegador",
  encontrar_dono: "navegador",
  curtir: "navegador",
  enviar_dm: "navegador",
  verificar_resposta: "navegador",
  qualificar: "geral",
  compor_abertura: "geral",
  compor_seguimento: "geral",
  sincronizar_caixa: "geral",
  compor_resposta: "geral",
  enviar_resposta: "geral",
} as const;

export type TipoJob = keyof typeof LANE_DO_TIPO;
export type Lane = (typeof LANE_DO_TIPO)[TipoJob];

export type Job = {
  id: number;
  tipo: TipoJob;
  lane: Lane;
  payload: Record<string, unknown>;
  operador: string | null;
  tentativas: number;
  max_tentativas: number;
};

/** Trabalho travado há mais que isso é de uma máquina que caiu: volta para a fila. */
export const TRAVA_VENCIDA_MINUTOS = 30;

function somarSegundos(iso: string, segundos: number): string {
  return new Date(new Date(iso).getTime() + segundos * 1000).toISOString();
}

/**
 * Enfileira um trabalho. A `chave` torna a operação idempotente: a mesma chave duas vezes (ou em duas
 * máquinas) gera um trabalho só. `operador` prende o trabalho a uma conta do Instagram (ex.: seguimento
 * de uma conversa que só aquela conta tem); sem ele, qualquer máquina pode pegar.
 */
export async function enfileirar(
  db: Banco,
  tipo: TipoJob,
  payload: Record<string, unknown>,
  opcoes: { chave?: string; prioridade?: number; executarEm?: string; operador?: string | null } = {},
): Promise<number | null> {
  const t = agora();
  const linha = await um<{ id: number }>(
    db,
    "insert into jobs (tipo, lane, payload, chave, operador, prioridade, executar_em, criado_em, atualizado_em) values (?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (chave) do nothing returning id",
    [tipo, LANE_DO_TIPO[tipo], JSON.stringify(payload), opcoes.chave ?? null, opcoes.operador ?? null, opcoes.prioridade ?? 0, opcoes.executarEm ?? t, t, t],
  );
  return linha ? Number(linha.id) : null;
}

/** Pega o próximo trabalho vencido da lane, do mais prioritário para o menos, e trava para este operador. */
export async function pegarProximo(db: Banco, lane: Lane, operador: string, momento = agora()): Promise<Job | null> {
  const travar = db.dialeto === "postgres" ? "for update skip locked" : "";
  const linha = await um<Linha>(
    db,
    `update jobs set status = 'rodando', tentativas = tentativas + 1, travado_por = ?, travado_em = ?, atualizado_em = ?
     where id = (
       select id from jobs
       where status = 'pendente' and lane = ? and executar_em <= ? and (operador is null or operador = ?)
       order by prioridade desc, executar_em, id
       limit 1 ${travar}
     ) and status = 'pendente'
     returning id, tipo, lane, payload, operador, tentativas, max_tentativas`,
    [operador, momento, momento, lane, momento, operador],
  );
  if (!linha) return null;
  return {
    id: Number(linha.id),
    tipo: linha.tipo as TipoJob,
    lane: linha.lane as Lane,
    payload: JSON.parse(String(linha.payload)) as Record<string, unknown>,
    operador: (linha.operador as string | null) ?? null,
    tentativas: Number(linha.tentativas),
    max_tentativas: Number(linha.max_tentativas),
  };
}

type Linha = Record<string, unknown>;

export async function concluir(db: Banco, id: number): Promise<void> {
  await db.todos("update jobs set status = 'feito', ultimo_erro = null, travado_por = null, travado_em = null, atualizado_em = ? where id = ?", [agora(), id]);
}

/** Adiar não conta tentativa: é ritmo, janela, pausa ou Chrome fora, não falha do trabalho. */
export async function adiar(db: Banco, id: number, segundos: number, motivo: string, momento = agora()): Promise<void> {
  await db.todos(
    "update jobs set status = 'pendente', tentativas = case when tentativas > 0 then tentativas - 1 else 0 end, executar_em = ?, ultimo_erro = ?, travado_por = null, travado_em = null, atualizado_em = ? where id = ?",
    [somarSegundos(momento, Math.max(1, Math.ceil(segundos))), `adiado: ${motivo}`, agora(), id],
  );
}

export function esperaDeRetentativa(tentativa: number): number {
  return Math.min(30 * 2 ** (tentativa - 1), 3600);
}

/** Falha conta tentativa. Volta com espera crescente (30 s, 60 s, 120 s...) até esgotar; aí morre. */
export async function falhar(db: Banco, job: Job, erro: unknown, momento = agora()): Promise<"retentar" | "morto"> {
  const mensagem = erro instanceof Error ? `${erro.name}: ${erro.message}` : String(erro);
  if (job.tentativas >= job.max_tentativas) {
    await db.todos("update jobs set status = 'morto', ultimo_erro = ?, travado_por = null, travado_em = null, atualizado_em = ? where id = ?", [mensagem, agora(), job.id]);
    return "morto";
  }
  await db.todos("update jobs set status = 'pendente', executar_em = ?, ultimo_erro = ?, travado_por = null, travado_em = null, atualizado_em = ? where id = ?", [
    somarSegundos(momento, esperaDeRetentativa(job.tentativas)),
    mensagem,
    agora(),
    job.id,
  ]);
  return "retentar";
}

/**
 * Retomada depois de queda: o que este operador deixou rodando volta para a fila, e o que qualquer
 * máquina deixou travado há mais de 30 minutos também (a máquina caiu e não volta para soltar).
 */
export async function recuperarTravados(db: Banco, operador: string, momento = agora()): Promise<number> {
  const limite = somarSegundos(momento, -TRAVA_VENCIDA_MINUTOS * 60);
  const linhas = await db.todos(
    "update jobs set status = 'pendente', travado_por = null, travado_em = null, atualizado_em = ? where status = 'rodando' and (travado_por = ? or travado_em < ?) returning id",
    [agora(), operador, limite],
  );
  return linhas.length;
}

export async function contarJobs(db: Banco): Promise<Array<{ lane: string; status: string; total: number }>> {
  const linhas = await db.todos<{ lane: string; status: string; total: unknown }>("select lane, status, cast(count(*) as integer) as total from jobs group by lane, status order by lane, status");
  return linhas.map((l) => ({ ...l, total: Number(l.total) }));
}
