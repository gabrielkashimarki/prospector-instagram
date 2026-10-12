// O processo que fica rodando: duas lanes (navegador e geral) e um agendador, num processo só.
// Política de erro: Chrome caído adia; sessão perdida e restrição pausam; falha comum tenta de novo
// com espera crescente e, se passar do limite por hora, pausa este operador.

import type { Config, Segredos } from "./config.ts";
import { agora, apagarEstado, type Banco, gravarEstado, lerEstado, registrarEvento, registrarOperador, um } from "./db.ts";
import { adiar, concluir, enfileirar, falhar, type Job, pegarProximo, recuperarTravados } from "./fila.ts";
import { TetoDeGastoAtingido } from "./ia.ts";
import { comPagina, reiniciarChrome } from "./navegador/chrome.ts";
import { chromeCaiu, RestricaoDoInstagram, SessaoPerdida } from "./navegador/erros.ts";
import { dentroDaJanela, liberacao, proximaAbertura, registrarAcao, sortear } from "./ritmo.ts";
import { ACAO_DO_TIPO, type Contexto, TRATADORES } from "./trabalhos.ts";

const ESPERA_CHROME_FORA_S = 5 * 60;

export type Pausa = { motivo: string; desde: string };

export async function pausar(db: Banco, operador: string, motivo: string): Promise<void> {
  await gravarEstado(db, `pausa:${operador}`, { motivo, desde: agora() } satisfies Pausa);
  await registrarEvento(db, operador, "pausa", motivo);
}

export async function retomar(db: Banco, operador: string): Promise<void> {
  await apagarEstado(db, `pausa:${operador}`);
  await registrarEvento(db, operador, "retomada", "retomado pela pessoa");
}

export function lerPausa(db: Banco, operador: string): Promise<Pausa | null> {
  return lerEstado<Pausa>(db, `pausa:${operador}`);
}

function log(mensagem: string): void {
  console.log(`${new Date().toLocaleTimeString("pt-BR")}  ${mensagem}`);
}

/** Retomada depois de queda: solta trabalhos travados e marca envios interrompidos para conferência. */
export async function prepararOperador(db: Banco, config: Config): Promise<void> {
  const operador = config.operador.instagram;
  await registrarOperador(db, config.operador.nome, operador);
  const soltos = await recuperarTravados(db, operador);
  if (soltos > 0) log(`${soltos} trabalho(s) interrompido(s) voltaram para a fila.`);
  const incertos = await db.todos("update leads set estado = 'incerto', atualizado_em = ? where estado = 'enviando' and operador = ? returning id", [agora(), operador]);
  await db.todos("update mensagens set status = 'incerta', atualizado_em = ? where status = 'enviando' and operador = ?", [agora(), operador]);
  if (incertos.length > 0) log(`${incertos.length} DM(s) foram interrompidas no clique de enviar. Estão como "incerto": confira no Instagram antes de qualquer coisa.`);
}

/** Decide o que fazer com o erro de um trabalho. Devolve segundos de folga para a lane do navegador. */
async function tratarErro(db: Banco, config: Config, operador: string, job: Job, erro: unknown): Promise<number> {
  if (chromeCaiu(erro)) {
    await adiar(db, job.id, ESPERA_CHROME_FORA_S, "Chrome indisponível");
    log(`Chrome indisponível (${erro instanceof Error ? erro.message.split("\n")[0] : erro}). Tento de novo em 5 min.`);
    return ESPERA_CHROME_FORA_S;
  }
  if (erro instanceof SessaoPerdida) {
    await pausar(db, operador, "Sessão do Instagram perdida. Entre de novo no Instagram na janela do Chrome dedicado e rode `npm run retomar`.");
    await adiar(db, job.id, 60, "pausado");
    return 0;
  }
  if (erro instanceof RestricaoDoInstagram) {
    await pausar(db, operador, `O Instagram restringiu uma ação: ${erro.message}. Abra o Instagram no Chrome dedicado, resolva o aviso e espere algumas horas antes de \`npm run retomar\`.`);
    await adiar(db, job.id, 60, "pausado");
    return 0;
  }
  if (erro instanceof TetoDeGastoAtingido) {
    await adiar(db, job.id, 3600, erro.message);
    log(erro.message);
    return 0;
  }
  const destino = await falhar(db, job, erro);
  const mensagem = erro instanceof Error ? erro.message : String(erro);
  await registrarEvento(db, operador, "falha", `${job.tipo} #${job.id} (${destino}): ${mensagem}`);
  log(`Falha em ${job.tipo} #${job.id}: ${mensagem}`);
  const umaHora = new Date(Date.now() - 3_600_000).toISOString();
  const falhas = await um<{ n: unknown }>(db, "select cast(count(*) as integer) as n from eventos where operador = ? and tipo = 'falha' and criado_em > ?", [operador, umaHora]);
  if (Number(falhas?.n ?? 0) >= config.limites.falhas_por_hora) {
    await pausar(db, operador, `${Number(falhas?.n)} falhas na última hora. Veja \`npm run status\` e rode \`npm run retomar\` quando resolver.`);
  }
  return 0;
}

type Estado = { parar: boolean; acoesNoNavegador: number; jobsDesdeReinicio: number; navegadorLivreEm: number };

const dormir = (ms: number, estado: Estado) =>
  new Promise<void>((resolve) => {
    const fim = Date.now() + ms;
    const tique = () => (estado.parar || Date.now() >= fim ? resolve() : setTimeout(tique, Math.min(1000, fim - Date.now())));
    tique();
  });

async function executar(db: Banco, config: Config, segredos: Segredos, job: Job, estado: Estado): Promise<boolean> {
  const operador = config.operador.instagram;
  let usouNavegador = false;
  const ctx: Contexto = {
    db,
    config,
    segredos,
    operador,
    log,
    navegador: (fn) => {
      usouNavegador = true;
      return comPagina(config, fn);
    },
  };
  try {
    const resultado = await TRATADORES[job.tipo](ctx, job);
    if (resultado) await adiar(db, job.id, resultado.adiar, resultado.motivo);
    else await concluir(db, job.id);
  } catch (erro) {
    const folga = await tratarErro(db, config, operador, job, erro);
    // Chrome fora do ar: nada aconteceu na conta, então a ação não conta nos limites.
    if (folga) {
      estado.navegadorLivreEm = Date.now() + folga * 1000;
      return false;
    }
  }
  return usouNavegador;
}

async function laneNavegador(db: Banco, config: Config, segredos: Segredos, estado: Estado): Promise<void> {
  const operador = config.operador.instagram;
  while (!estado.parar) {
    if (await lerPausa(db, operador)) {
      await dormir(30_000, estado);
      continue;
    }
    const agoraData = new Date();
    if (!dentroDaJanela(agoraData, config.janela)) {
      const abre = proximaAbertura(agoraData, config.janela);
      log(`Fora da janela de horário. Navegador volta às ${abre.toLocaleString("pt-BR", { timeZone: config.janela.fuso })}.`);
      await dormir(Math.min(abre.getTime() - Date.now(), 15 * 60_000), estado);
      continue;
    }
    if (Date.now() < estado.navegadorLivreEm) {
      await dormir(estado.navegadorLivreEm - Date.now(), estado);
      continue;
    }
    const job = await pegarProximo(db, "navegador", operador);
    if (!job) {
      await dormir(15_000, estado);
      continue;
    }
    const acao = ACAO_DO_TIPO[job.tipo];
    if (acao) {
      const lib = await liberacao(db, config, operador, acao);
      if (!lib.ok) {
        await adiar(db, job.id, lib.esperarSegundos, lib.motivo);
        continue;
      }
    }
    log(`Navegador: ${job.tipo} ${JSON.stringify(job.payload)}`);
    const usou = await executar(db, config, segredos, job, estado);
    if (!usou) continue;
    if (acao) await registrarAcao(db, config, operador, acao);
    estado.acoesNoNavegador += 1;
    estado.jobsDesdeReinicio += 1;
    if (config.chrome.reiniciar_a_cada_jobs > 0 && estado.jobsDesdeReinicio >= config.chrome.reiniciar_a_cada_jobs) {
      estado.jobsDesdeReinicio = 0;
      if (await reiniciarChrome(config).catch(() => false)) log("Chrome dedicado reiniciado para liberar memória.");
    }
    const { pausa_longa, entre_acoes_segundos } = config.pausas;
    if (estado.acoesNoNavegador % pausa_longa.a_cada_acoes === 0) {
      const minutos = sortear(pausa_longa.minutos[0], pausa_longa.minutos[1]);
      log(`Pausa longa de ${minutos} min.`);
      await dormir(minutos * 60_000, estado);
    } else {
      await dormir(sortear(entre_acoes_segundos[0], entre_acoes_segundos[1]) * 1000, estado);
    }
  }
}

async function laneGeral(db: Banco, config: Config, segredos: Segredos, estado: Estado): Promise<void> {
  while (!estado.parar) {
    if (await lerPausa(db, config.operador.instagram)) {
      await dormir(30_000, estado);
      continue;
    }
    const job = await pegarProximo(db, "geral", config.operador.instagram);
    if (!job) {
      await dormir(5_000, estado);
      continue;
    }
    await executar(db, config, segredos, job, estado);
  }
}

/** Agenda o que é periódico: sincronizar a caixa, eventos do webhook, conferir respostas e seguimentos. */
export async function agendar(db: Banco, config: Config, momento = new Date()): Promise<void> {
  const operador = config.operador.instagram;
  if (config.caixa.provedor !== "nenhum") {
    const balde = Math.floor(momento.getTime() / (config.caixa.sincronizar_a_cada_minutos * 60_000));
    await enfileirar(db, "sincronizar_caixa", {}, { chave: `sincronizar_caixa:${operador}:${balde}`, operador });
    if (config.caixa.receber === "webhook_supabase") {
      const ultimo = await um<{ id: unknown }>(db, "select max(id) as id from caixa_eventos");
      const visto = (await lerEstado<number>(db, `ultimo_evento_visto:${operador}`)) ?? 0;
      if (Number(ultimo?.id ?? 0) > visto) {
        await gravarEstado(db, `ultimo_evento_visto:${operador}`, Number(ultimo?.id));
        await enfileirar(db, "sincronizar_caixa", {}, { chave: `sincronizar_caixa:${operador}:evento:${ultimo?.id}`, operador });
      }
    }
  }
  if (config.modo !== "envio") return;
  // Rascunhos feitos no modo rascunho entram na fila de envio quando o modo envio é ligado.
  const semEnvio = await db.todos<{ id: number }>("select id from leads where estado = 'rascunho' and not exists (select 1 from jobs where jobs.chave = 'enviar_dm:' || leads.id || ':abertura')");
  for (const lead of semEnvio) await enfileirar(db, "enviar_dm", { leadId: Number(lead.id), tipo: "abertura" }, { chave: `enviar_dm:${lead.id}:abertura`, prioridade: 40 });
  const limite = new Date(momento.getTime() - config.seguimento.dias * 86_400_000).toISOString();
  const parados = await db.todos<{ id: number; seguimentos: number }>("select id, seguimentos from leads where operador = ? and estado = 'enviado' and respondeu_em is null and ultimo_envio_em < ?", [operador, limite]);
  for (const lead of parados) {
    if (config.caixa.provedor === "nenhum") {
      await enfileirar(db, "verificar_resposta", { leadId: Number(lead.id) }, { chave: `verificar_resposta:${lead.id}:${lead.seguimentos}`, operador, prioridade: 15 });
    } else if (config.seguimento.ativo && lead.seguimentos < config.seguimento.maximo) {
      await enfileirar(db, "compor_seguimento", { leadId: Number(lead.id) }, { chave: `compor_seguimento:${lead.id}:${lead.seguimentos + 1}`, operador });
    }
  }
}

export async function rodar(db: Banco, config: Config, segredos: Segredos): Promise<void> {
  await prepararOperador(db, config);
  const estado: Estado = { parar: false, acoesNoNavegador: 0, jobsDesdeReinicio: 0, navegadorLivreEm: 0 };
  const parar = () => {
    if (estado.parar) process.exit(1);
    estado.parar = true;
    log("Parando depois do trabalho atual (Ctrl+C de novo força).");
  };
  process.on("SIGINT", parar);
  process.on("SIGTERM", parar);
  log(`Rodando como @${config.operador.instagram}, modo ${config.modo === "envio" ? "ENVIO (DMs de verdade)" : "rascunho (nenhuma DM sai)"}. Ctrl+C para parar.`);
  const agendador = (async () => {
    while (!estado.parar) {
      await agendar(db, config).catch((erro: unknown) => log(`Agendador: ${erro instanceof Error ? erro.message : erro}`));
      await dormir(30_000, estado);
    }
  })();
  await Promise.all([agendador, laneNavegador(db, config, segredos, estado), laneGeral(db, config, segredos, estado)]);
}
