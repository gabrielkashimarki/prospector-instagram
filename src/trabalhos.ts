// O que cada tipo de trabalho faz. Estados do lead, na ordem do funil:
// novo → lido → qualificado (ou descartado, sem_perfil) → [via_dono] → rascunho → enviado → quente
// Saídas laterais: nao_entregavel, sem_dm, encerrado, incerto (envio interrompido: confira à mão).

import type { Page } from "playwright-core";
import { caixaMeta, caixaZernio, ErroDaCaixa, type Caixa } from "./caixa.ts";
import type { Config, Segredos } from "./config.ts";
import { agora, atualizarLead, type Banco, criarLead, lerLead, type Lead, registrarEvento, reservarLead, um } from "./db.ts";
import { enfileirar, type Job, type TipoJob } from "./fila.ts";
import { chamarIA, extrairJson, lerClassificacao, promptAbertura, promptClassificacao, promptResposta, promptSeguimento, validarMensagem } from "./ia.ts";
import { DmIndisponivel, DmNaoEntregavel, PerfilNaoEncontrado } from "./navegador/erros.ts";
import { buscarContas, buscarHashtag, contatoRespondeu, curtirUltimoPost, enviarDM, lerPerfil } from "./navegador/instagram.ts";
import { mencoesDeDono, notaFinal, preNota } from "./qualificacao.ts";
import { sortear } from "./ritmo.ts";

export type Contexto = {
  db: Banco;
  config: Config;
  segredos: Segredos;
  operador: string;
  /** Abre uma aba do Chrome dedicado só quando o trabalho precisa dela. */
  navegador<T>(fn: (page: Page) => Promise<T>): Promise<T>;
  log(mensagem: string): void;
};

export type Resultado = void | { adiar: number; motivo: string };
type Tratador = (ctx: Contexto, job: Job) => Promise<Resultado>;

const PRIORIDADE = { descobrir: 10, ler_perfil: 20, encontrar_dono: 25, curtir: 30, enviar_dm: 40, verificar_resposta: 15 } as const;

function leadId(job: Job): number {
  const id = Number(job.payload.leadId);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`Trabalho ${job.id} sem leadId válido`);
  return id;
}

/** A conta da própria pessoa e a lista de "nunca contatar" ficam de fora de tudo. */
function proibido(config: Config, usuario: string): boolean {
  const limpo = (u: string) => u.trim().replace(/^@/, "").toLowerCase();
  return usuario === config.operador.instagram || config.descoberta.nunca_contatar.map(limpo).includes(usuario);
}

async function seguirParaAbertura(ctx: Contexto, id: number): Promise<void> {
  await enfileirar(ctx.db, "compor_abertura", { leadId: id }, { chave: `compor_abertura:${id}` });
  if (ctx.config.modo === "envio" && ctx.config.curtir_antes_da_dm) await enfileirar(ctx.db, "curtir", { leadId: id }, { chave: `curtir:${id}`, prioridade: PRIORIDADE.curtir });
}

/** A DM para o dono não saiu: a empresa, que estava segurada, volta para a fila com abertura própria. */
async function devolverEmpresa(ctx: Contexto, lead: Lead): Promise<void> {
  if (!lead.dono_de) return;
  const empresa = await lerLead(ctx.db, lead.dono_de);
  if (empresa?.estado !== "via_dono") return;
  await atualizarLead(ctx.db, empresa.id, { estado: "qualificado" });
  await enfileirar(ctx.db, "compor_abertura", { leadId: empresa.id }, { chave: `compor_abertura:${empresa.id}:apos_dono` });
}

const descobrir: Tratador = async (ctx, job) => {
  const fonte = String(job.payload.fonte);
  const valor = String(job.payload.valor);
  const limite = ctx.config.descoberta.max_perfis_por_busca;
  const usuarios =
    fonte === "hashtag"
      ? await ctx.navegador((page) => buscarHashtag(page, valor, limite))
      : (await ctx.navegador((page) => buscarContas(page, valor, limite))).filter((c) => !c.privada).map((c) => c.usuario);
  let novos = 0;
  for (const usuario of usuarios) {
    if (proibido(ctx.config, usuario)) continue;
    const lead = await criarLead(ctx.db, usuario, `${fonte}:${valor}`);
    if (!lead.novo) continue;
    novos += 1;
    await enfileirar(ctx.db, "ler_perfil", { leadId: lead.id }, { chave: `ler_perfil:${lead.id}`, prioridade: PRIORIDADE.ler_perfil });
  }
  await registrarEvento(ctx.db, ctx.operador, "descoberta", `${fonte} "${valor}": ${usuarios.length} perfis, ${novos} novos`);
};

const lerPerfilDoLead: Tratador = async (ctx, job) => {
  const lead = await lerLead(ctx.db, leadId(job));
  if (lead?.estado !== "novo") return;
  try {
    const p = await ctx.navegador((page) => lerPerfil(page, lead.usuario));
    await atualizarLead(ctx.db, lead.id, {
      estado: "lido",
      nome: p.nome,
      bio: p.bio,
      seguidores: p.seguidores,
      seguindo: p.seguindo,
      posts: p.posts,
      link_externo: p.linkExterno,
      comercial: p.comercial ? 1 : 0,
      legendas: JSON.stringify(p.legendas),
    });
    await enfileirar(ctx.db, "qualificar", { leadId: lead.id }, { chave: `qualificar:${lead.id}` });
  } catch (erro) {
    if (!(erro instanceof PerfilNaoEncontrado)) throw erro;
    await atualizarLead(ctx.db, lead.id, { estado: "sem_perfil" });
  }
};

const qualificar: Tratador = async (ctx, job) => {
  const lead = await lerLead(ctx.db, leadId(job));
  if (lead?.estado !== "lido") return;
  const legendas = lead.legendas ? (JSON.parse(lead.legendas) as string[]) : [];
  const pre = preNota({ usuario: lead.usuario, nome: lead.nome, bio: lead.bio, comercial: lead.comercial === 1, seguidores: lead.seguidores, posts: lead.posts, linkExterno: lead.link_externo, legendas }, ctx.config.qualificacao);
  const ia = !pre.eliminado && ctx.config.qualificacao.usar_ia ? lerClassificacao(await chamarIA(ctx.db, ctx.config, ctx.segredos.iaChave, ctx.operador, promptClassificacao(ctx.config, lead))) : null;
  const nota = notaFinal(pre, ia);
  const motivos = [...pre.sinais, ...(ia ? [`ia:${ia.encaixe}:${ia.motivo}`] : [])].join(" | ");
  const passou = nota >= ctx.config.qualificacao.pontuacao_minima;
  await atualizarLead(ctx.db, lead.id, { estado: passou ? "qualificado" : "descartado", pontuacao: nota, motivos });
  if (!passou) return;
  if (ctx.config.dono.buscar_na_bio && mencoesDeDono(lead.bio, lead.usuario).length > 0) {
    await enfileirar(ctx.db, "encontrar_dono", { leadId: lead.id }, { chave: `encontrar_dono:${lead.id}`, prioridade: PRIORIDADE.encontrar_dono });
    return;
  }
  await seguirParaAbertura(ctx, lead.id);
};

/** A bio diz quem decide ("CEO: @fulano"): a abordagem vai para a pessoa, e a empresa espera. */
const encontrarDono: Tratador = async (ctx, job) => {
  const empresa = await lerLead(ctx.db, leadId(job));
  if (empresa?.estado !== "qualificado") return;
  for (const mencao of mencoesDeDono(empresa.bio, empresa.usuario)) {
    if (proibido(ctx.config, mencao.usuario)) continue;
    let perfil;
    try {
      perfil = await ctx.navegador((page) => lerPerfil(page, mencao.usuario, 0));
    } catch (erro) {
      if (erro instanceof PerfilNaoEncontrado) continue;
      throw erro;
    }
    const dono = await criarLead(ctx.db, mencao.usuario, `dono_de:@${empresa.usuario}`, { dono_de: empresa.id, estado: "qualificado", pontuacao: empresa.pontuacao });
    // Já estava na base por conta própria: segue o caminho dele, sem abordar duas vezes.
    if (!dono.novo) continue;
    await atualizarLead(ctx.db, dono.id, { nome: perfil.nome, bio: perfil.bio, seguidores: perfil.seguidores, seguindo: perfil.seguindo, posts: perfil.posts, link_externo: perfil.linkExterno, motivos: `${mencao.cargo} citado na bio de @${empresa.usuario}` });
    await atualizarLead(ctx.db, empresa.id, { estado: "via_dono" });
    await seguirParaAbertura(ctx, dono.id);
    return;
  }
  await seguirParaAbertura(ctx, empresa.id);
};

const comporAbertura: Tratador = async (ctx, job) => {
  const lead = await lerLead(ctx.db, leadId(job));
  if (lead?.estado !== "qualificado") return;
  const empresa = lead.dono_de ? ((await lerLead(ctx.db, lead.dono_de)) ?? null) : null;
  const texto = validarMensagem(await chamarIA(ctx.db, ctx.config, ctx.segredos.iaChave, ctx.operador, promptAbertura(ctx.config, lead, empresa)), ctx.config.mensagem.max_caracteres);
  await atualizarLead(ctx.db, lead.id, { estado: "rascunho", abertura: texto });
  if (ctx.config.modo === "envio") await enfileirar(ctx.db, "enviar_dm", { leadId: lead.id, tipo: "abertura" }, { chave: `enviar_dm:${lead.id}:abertura`, prioridade: PRIORIDADE.enviar_dm });
};

const curtir: Tratador = async (ctx, job) => {
  if (ctx.config.modo !== "envio") return;
  const lead = await lerLead(ctx.db, leadId(job));
  if (!lead || proibido(ctx.config, lead.usuario) || !["qualificado", "rascunho"].includes(lead.estado)) return;
  try {
    const r = await ctx.navegador((page) => curtirUltimoPost(page, lead.usuario));
    await registrarEvento(ctx.db, ctx.operador, "curtida", r, lead.id);
  } catch (erro) {
    if (!(erro instanceof PerfilNaoEncontrado)) throw erro;
  }
};

class LeadJaReservado extends Error {}

/**
 * Primeira DM e seguimento, pelo Chrome. A reserva do lead acontece logo antes do clique de enviar:
 * com várias máquinas, só uma ganha, e um lead nunca recebe a mesma mensagem duas vezes.
 */
const enviarDm: Tratador = async (ctx, job) => {
  // Voltou para rascunho com DM na fila: espera em vez de concluir, para sair quando o envio for religado.
  if (ctx.config.modo !== "envio") return { adiar: 3600, motivo: "modo rascunho" };
  const lead = await lerLead(ctx.db, leadId(job));
  if (!lead || proibido(ctx.config, lead.usuario)) return;
  if (lead.estado === "enviando" && lead.operador === ctx.operador) {
    // Uma tentativa anterior chegou no clique e não voltou: pode ter saído. Nunca reenvia sozinho.
    await atualizarLead(ctx.db, lead.id, { estado: "incerto" });
    return;
  }
  const seguimento = job.payload.tipo === "seguimento";
  const esperado = seguimento ? "enviado" : "rascunho";
  const texto = seguimento ? lead.seguimento : lead.abertura;
  if (lead.estado !== esperado || !texto || (seguimento && (lead.respondeu_em || lead.operador !== ctx.operador))) return;
  try {
    const r = await ctx.navegador((page) =>
      enviarDM(page, lead.usuario, texto, async () => {
        if (!(await reservarLead(ctx.db, lead.id, esperado, ctx.operador))) throw new LeadJaReservado();
      }),
    );
    const t = agora();
    await atualizarLead(ctx.db, lead.id, seguimento ? { estado: "enviado", ultimo_envio_em: t, seguimentos: lead.seguimentos + 1 } : { estado: "enviado", contatado_em: t, ultimo_envio_em: t });
    await ctx.db.todos("insert into mensagens (lead_id, operador, direcao, texto, status, criado_em, atualizado_em) values (?, ?, 'saida', ?, 'enviada', ?, ?)", [lead.id, ctx.operador, texto, t, t]);
    await registrarEvento(ctx.db, ctx.operador, seguimento ? "seguimento_enviado" : "dm_enviada", r.confirmado ? "confirmada" : "enviada sem confirmação visual", lead.id);
  } catch (erro) {
    if (erro instanceof LeadJaReservado) return;
    const depoisDoClique = seguimento ? "enviado" : null;
    if (erro instanceof DmNaoEntregavel) {
      await atualizarLead(ctx.db, lead.id, { estado: depoisDoClique ?? "nao_entregavel" });
      if (!seguimento) await devolverEmpresa(ctx, lead);
      return;
    }
    if (erro instanceof DmIndisponivel && erro.retentavel && job.tentativas < job.max_tentativas) {
      if (seguimento) await atualizarLead(ctx.db, lead.id, { estado: "enviado" });
      // O Instagram segura conversas novas depois de uma rajada; o mesmo perfil abre minutos depois.
      return { adiar: sortear(30 * 60, 60 * 60), motivo: erro.message };
    }
    if (erro instanceof DmIndisponivel || erro instanceof PerfilNaoEncontrado) {
      await atualizarLead(ctx.db, lead.id, { estado: depoisDoClique ?? (erro instanceof PerfilNaoEncontrado ? "sem_perfil" : "sem_dm") });
      if (!seguimento) await devolverEmpresa(ctx, lead);
      return;
    }
    throw erro;
  }
};

/** Sem integração de caixa: abre a conversa no Chrome para ver se o contato respondeu. */
const verificarResposta: Tratador = async (ctx, job) => {
  const lead = await lerLead(ctx.db, leadId(job));
  if (lead?.estado !== "enviado" || lead.respondeu_em || lead.operador !== ctx.operador) return;
  const respondeu = await ctx.navegador((page) => contatoRespondeu(page, lead.usuario));
  if (respondeu) {
    await atualizarLead(ctx.db, lead.id, { estado: "quente", respondeu_em: agora() });
    await registrarEvento(ctx.db, ctx.operador, "lead_quente", "respondeu a DM", lead.id);
    return;
  }
  if (ctx.config.seguimento.ativo && lead.seguimentos < ctx.config.seguimento.maximo) {
    await enfileirar(ctx.db, "compor_seguimento", { leadId: lead.id }, { chave: `compor_seguimento:${lead.id}:${lead.seguimentos + 1}`, operador: ctx.operador });
  }
};

const comporSeguimento: Tratador = async (ctx, job) => {
  const lead = await lerLead(ctx.db, leadId(job));
  if (lead?.estado !== "enviado" || lead.respondeu_em) return;
  const texto = validarMensagem(await chamarIA(ctx.db, ctx.config, ctx.segredos.iaChave, ctx.operador, promptSeguimento(ctx.config, lead)), ctx.config.mensagem.max_caracteres);
  await atualizarLead(ctx.db, lead.id, { seguimento: texto });
  await enfileirar(ctx.db, "enviar_dm", { leadId: lead.id, tipo: "seguimento" }, { chave: `enviar_dm:${lead.id}:seguimento:${lead.seguimentos + 1}`, prioridade: PRIORIDADE.enviar_dm, operador: ctx.operador });
};

export function caixaDoOperador(config: Config, segredos: Segredos): Caixa | null {
  if (config.caixa.provedor === "zernio") {
    if (!segredos.zernioChave || !config.caixa.zernio_conta) throw new Error("Caixa Zernio sem ZERNIO_API_KEY no .env ou sem caixa.zernio_conta no config.yaml.");
    return caixaZernio({ chave: segredos.zernioChave, conta: config.caixa.zernio_conta });
  }
  if (config.caixa.provedor === "meta") {
    if (!segredos.metaToken) throw new Error("Caixa Meta sem META_ACCESS_TOKEN no .env.");
    return caixaMeta({ token: segredos.metaToken, minhaConta: config.operador.instagram });
  }
  return null;
}

/** Lê a caixa pela API, grava mensagens novas e marca quem respondeu como lead quente. */
const sincronizarCaixa: Tratador = async (ctx) => {
  const caixa = caixaDoOperador(ctx.config, ctx.segredos);
  if (!caixa) return;
  const contatados = await ctx.db.todos<{ id: number; usuario: string }>("select id, usuario from leads where operador = ? and contatado_em is not null", [ctx.operador]);
  if (contatados.length === 0) return;
  const porUsuario = new Map(contatados.map((l) => [l.usuario, Number(l.id)]));
  let conversas;
  try {
    conversas = await caixa.listar(new Set(porUsuario.keys()));
  } catch (erro) {
    if (erro instanceof ErroDaCaixa && erro.tipo === "limite") return { adiar: 300, motivo: "limite da API da caixa" };
    throw erro;
  }
  for (const conversa of conversas) {
    const id = porUsuario.get(conversa.usuario);
    if (!id) continue;
    let ultimaNova: string | null = null;
    for (const m of [...conversa.mensagens].sort((a, b) => a.em.localeCompare(b.em))) {
      const nova = await um(
        ctx.db,
        "insert into mensagens (lead_id, operador, externo_id, conversa_id, contato_id, direcao, texto, status, criado_em, atualizado_em) values (?, ?, ?, ?, ?, ?, ?, 'recebida', ?, ?) on conflict (externo_id) do nothing returning id",
        [id, ctx.operador, `${ctx.config.caixa.provedor}:${m.id}`, conversa.conversaId, conversa.contatoId, m.entrada ? "entrada" : "saida", m.texto, m.em, agora()],
      );
      if (nova && m.entrada) ultimaNova = m.id;
    }
    if (!ultimaNova) continue;
    const lead = await lerLead(ctx.db, id);
    if (lead && !lead.respondeu_em) {
      await atualizarLead(ctx.db, id, { estado: lead.estado === "enviado" ? "quente" : lead.estado, respondeu_em: agora() });
      await registrarEvento(ctx.db, ctx.operador, "lead_quente", "respondeu a DM", id);
    }
    if (ctx.config.caixa.respostas !== "desligado") await enfileirar(ctx.db, "compor_resposta", { leadId: id }, { chave: `compor_resposta:${ultimaNova}`, operador: ctx.operador });
  }
};

const comporResposta: Tratador = async (ctx, job) => {
  const lead = await lerLead(ctx.db, leadId(job));
  if (!lead || lead.estado === "encerrado") return;
  const historico = await ctx.db.todos<{ direcao: string; texto: string }>("select direcao, texto from mensagens where lead_id = ? and status in ('recebida', 'enviada') order by criado_em desc limit 20", [lead.id]);
  const conversa = historico.reverse();
  if (lead.abertura && !conversa.some((c) => c.direcao === "saida")) conversa.unshift({ direcao: "saida", texto: lead.abertura });
  const decisao = extrairJson(await chamarIA(ctx.db, ctx.config, ctx.segredos.iaChave, ctx.operador, promptResposta(ctx.config, lead, conversa)));
  if (decisao.acao === "encerrar") {
    await atualizarLead(ctx.db, lead.id, { estado: "encerrado" });
    await registrarEvento(ctx.db, ctx.operador, "conversa_encerrada", "a IA leu pedido para parar ou falta de interesse", lead.id);
    return;
  }
  if (decisao.acao !== "responder") {
    await registrarEvento(ctx.db, ctx.operador, "precisa_de_humano", "o contato pediu algo que só você resolve", lead.id);
    return;
  }
  const texto = validarMensagem(String(decisao.texto ?? ""), ctx.config.mensagem.max_caracteres * 2);
  const t = agora();
  const msg = await um<{ id: number }>(ctx.db, "insert into mensagens (lead_id, operador, direcao, texto, status, criado_em, atualizado_em) values (?, ?, 'saida', ?, 'rascunho', ?, ?) returning id", [lead.id, ctx.operador, texto, t, t]);
  if (ctx.config.caixa.respostas === "automatico") await enfileirar(ctx.db, "enviar_resposta", { mensagemId: Number(msg!.id) }, { chave: `enviar_resposta:${msg!.id}`, operador: ctx.operador });
};

const JANELA_META_MS = 24 * 3_600_000;

/** Resposta pela API oficial. Só dentro de 24 h da última mensagem do contato (regra da Meta). */
const enviarResposta: Tratador = async (ctx, job) => {
  const mensagemId = Number(job.payload.mensagemId);
  const msg = await um<{ id: number; lead_id: number; texto: string; status: string }>(ctx.db, "select id, lead_id, texto, status from mensagens where id = ?", [mensagemId]);
  if (!msg || !["rascunho", "aprovada"].includes(msg.status)) return;
  const ultima = await um<{ conversa_id: string; contato_id: string; criado_em: string }>(
    ctx.db,
    "select conversa_id, contato_id, criado_em from mensagens where lead_id = ? and direcao = 'entrada' and conversa_id is not null order by criado_em desc limit 1",
    [msg.lead_id],
  );
  const marcar = (status: string) => ctx.db.todos("update mensagens set status = ?, atualizado_em = ? where id = ?", [status, agora(), msg.id]);
  if (!ultima || Date.now() - new Date(ultima.criado_em).getTime() > JANELA_META_MS) {
    await marcar("fora_da_janela");
    return;
  }
  const caixa = caixaDoOperador(ctx.config, ctx.segredos);
  if (!caixa) return;
  // Trava antes de chamar a API: duas máquinas (ou um `aprovar` repetido) nunca mandam a mesma resposta.
  const travada = await um(ctx.db, "update mensagens set status = 'enviando', atualizado_em = ? where id = ? and status in ('rascunho', 'aprovada') returning id", [agora(), msg.id]);
  if (!travada) return;
  try {
    await caixa.enviar({ conversaId: ultima.conversa_id, contatoId: ultima.contato_id }, msg.texto);
    await marcar("enviada");
  } catch (erro) {
    // Erro depois de chamar a API pode ser envio que saiu: não tenta de novo sozinho.
    await marcar(erro instanceof ErroDaCaixa && erro.tipo === "janela_fechada" ? "fora_da_janela" : "falhou");
    await registrarEvento(ctx.db, ctx.operador, "resposta_falhou", erro instanceof Error ? erro.message : String(erro), msg.lead_id);
  }
};

export const TRATADORES: Record<TipoJob, Tratador> = {
  descobrir,
  ler_perfil: lerPerfilDoLead,
  qualificar,
  encontrar_dono: encontrarDono,
  compor_abertura: comporAbertura,
  curtir,
  enviar_dm: enviarDm,
  verificar_resposta: verificarResposta,
  compor_seguimento: comporSeguimento,
  sincronizar_caixa: sincronizarCaixa,
  compor_resposta: comporResposta,
  enviar_resposta: enviarResposta,
};

/** Que ação de conta cada trabalho do navegador gasta (para os limites por hora e por dia). */
export const ACAO_DO_TIPO: Partial<Record<TipoJob, "dm" | "curtida" | "leitura" | "busca">> = {
  descobrir: "busca",
  ler_perfil: "leitura",
  encontrar_dono: "leitura",
  verificar_resposta: "leitura",
  curtir: "curtida",
  enviar_dm: "dm",
};
