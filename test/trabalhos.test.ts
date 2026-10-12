import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { validarConfig, type Config } from "../src/config.ts";
import { atualizarLead, type Banco, criarLead, lerLead, um } from "../src/db.ts";
import { pegarProximo } from "../src/fila.ts";
import { type Contexto, TRATADORES } from "../src/trabalhos.ts";
import { DIALETOS } from "./bancos.ts";

const exemplo = validarConfig(parse(readFileSync(new URL("../config.example.yaml", import.meta.url), "utf8")));

/** IA e Zernio falsas: respondem pelo endereço e pelo tipo de prompt. */
function fetchFalso(zernio: { mensagens: unknown[] }) {
  return vi.fn(async (entrada: string | URL, init?: RequestInit) => {
    const url = String(entrada);
    const corpo = init?.body ? (JSON.parse(String(init.body)) as { system?: string }) : {};
    const json = (dados: unknown) => new Response(JSON.stringify(dados), { status: 200 });
    if (url.startsWith("https://api.anthropic.com")) {
      const texto = corpo.system?.includes('"encaixe"')
        ? '{"encaixe": 90, "motivo": "clínica de estética ativa"}'
        : corpo.system?.includes('"acao"')
          ? '{"acao": "responder", "texto": "Que bom! Posso te mostrar em 10 minutos?"}'
          : "Oi! Vi que vocês fazem estética facial. Como organizam a agenda hoje?";
      return json({ content: [{ type: "text", text: texto }], usage: { input_tokens: 300, output_tokens: 40 } });
    }
    if (url.includes("/inbox/conversations/c1/messages") && init?.method === "POST") return json({ id: "ok" });
    if (url.includes("/inbox/conversations/c1/messages")) return json({ messages: zernio.mensagens });
    if (url.includes("/inbox/conversations")) return json({ conversations: [{ id: "c1", participantId: "p1", participantUsername: "clinica.exemplo" }] });
    return new Response("{}", { status: 404 });
  });
}

describe.each(DIALETOS)("funil de ponta a ponta sem navegador ($nome)", ({ abrir }) => {
  let db: Banco;
  let config: Config;
  const ctx = (): Contexto => ({
    db,
    config,
    segredos: { iaChave: "chave-teste", databaseUrl: undefined, zernioChave: "zernio-teste", metaToken: undefined },
    operador: config.operador.instagram,
    navegador: () => Promise.reject(new Error("este teste não usa o navegador")),
    log: () => undefined,
  });
  const rodarProximo = async (lane: "navegador" | "geral") => {
    const job = await pegarProximo(db, lane, config.operador.instagram);
    if (!job) throw new Error(`fila ${lane} vazia`);
    return { job, resultado: await TRATADORES[job.tipo](ctx(), job) };
  };

  beforeEach(async () => {
    ({ db } = await abrir());
    config = { ...exemplo, operador: { nome: "Pessoa", instagram: "minha_conta" }, qualificacao: { ...exemplo.qualificacao, palavras_chave: ["estetica"], palavras_negativas: [] } };
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.fechar();
  });

  it("modo rascunho: qualifica, escreve a abertura e não agenda envio", async () => {
    vi.stubGlobal("fetch", fetchFalso({ mensagens: [] }));
    const { id } = await criarLead(db, "clinica.exemplo", "busca:x", { estado: "lido" });
    await atualizarLead(db, id, { nome: "Clínica Exemplo", bio: "Estética facial. Agende pelo WhatsApp", seguidores: 3000, posts: 200, comercial: 1, legendas: "[]" });
    await TRATADORES.qualificar(ctx(), { id: 0, tipo: "qualificar", lane: "geral", payload: { leadId: id }, operador: null, tentativas: 1, max_tentativas: 3 });
    expect(await lerLead(db, id)).toMatchObject({ estado: "qualificado", pontuacao: 73 });
    const { job } = await rodarProximo("geral");
    expect(job.tipo).toBe("compor_abertura");
    expect(await lerLead(db, id)).toMatchObject({ estado: "rascunho", abertura: "Oi! Vi que vocês fazem estética facial. Como organizam a agenda hoje?" });
    expect(await pegarProximo(db, "navegador", "minha_conta")).toBeNull();
  });

  it("modo envio agenda a DM; perfil na lista de nunca contatar não sai", async () => {
    vi.stubGlobal("fetch", fetchFalso({ mensagens: [] }));
    config = { ...config, modo: "envio", descoberta: { ...config.descoberta, nunca_contatar: ["@Clinica.Exemplo"] } };
    const { id } = await criarLead(db, "clinica.exemplo", "busca:x", { estado: "qualificado" });
    await TRATADORES.compor_abertura(ctx(), { id: 0, tipo: "compor_abertura", lane: "geral", payload: { leadId: id }, operador: null, tentativas: 1, max_tentativas: 3 });
    const { job } = await rodarProximo("navegador");
    expect(job).toMatchObject({ tipo: "enviar_dm", payload: { leadId: id, tipo: "abertura" } });
    expect((await lerLead(db, id))?.estado).toBe("rascunho");
  });

  it("resposta pela Zernio vira lead quente e rascunho de resposta; envio respeita a janela de 24 h", async () => {
    const agora = new Date().toISOString();
    vi.stubGlobal("fetch", fetchFalso({ mensagens: [{ id: "m1", message: "Tenho interesse", direction: "incoming", sentAt: agora }] }));
    config = { ...config, caixa: { ...config.caixa, provedor: "zernio", zernio_conta: "conta1" } };
    const { id } = await criarLead(db, "clinica.exemplo", "busca:x", { estado: "enviado" });
    await atualizarLead(db, id, { operador: "minha_conta", contatado_em: agora, abertura: "Oi!" });
    await TRATADORES.sincronizar_caixa(ctx(), { id: 0, tipo: "sincronizar_caixa", lane: "geral", payload: {}, operador: "minha_conta", tentativas: 1, max_tentativas: 3 });
    expect(await lerLead(db, id)).toMatchObject({ estado: "quente" });
    // Sincronizar de novo não duplica a mensagem nem o trabalho.
    await TRATADORES.sincronizar_caixa(ctx(), { id: 0, tipo: "sincronizar_caixa", lane: "geral", payload: {}, operador: "minha_conta", tentativas: 1, max_tentativas: 3 });
    expect(Number((await um<{ n: unknown }>(db, "select cast(count(*) as integer) as n from mensagens where direcao = 'entrada'"))?.n)).toBe(1);
    await rodarProximo("geral");
    const rascunho = await um<{ id: number; status: string; texto: string }>(db, "select id, status, texto from mensagens where direcao = 'saida' and status = 'rascunho'");
    expect(rascunho).toMatchObject({ texto: "Que bom! Posso te mostrar em 10 minutos?" });
    await expect(pegarProximo(db, "geral", "minha_conta")).resolves.toBeNull();

    await db.todos("update mensagens set status = 'aprovada' where id = ?", [rascunho!.id]);
    await TRATADORES.enviar_resposta(ctx(), { id: 0, tipo: "enviar_resposta", lane: "geral", payload: { mensagemId: rascunho!.id }, operador: "minha_conta", tentativas: 1, max_tentativas: 3 });
    expect((await um<{ status: string }>(db, "select status from mensagens where id = ?", [rascunho!.id]))?.status).toBe("enviada");

    const antiga = new Date(Date.now() - 30 * 3_600_000).toISOString();
    await db.todos("update mensagens set criado_em = ? where direcao = 'entrada'", [antiga]);
    const outra = await um<{ id: number }>(db, "insert into mensagens (lead_id, operador, direcao, texto, status, criado_em, atualizado_em) values (?, 'minha_conta', 'saida', 'oi de novo', 'aprovada', ?, ?) returning id", [id, agora, agora]);
    await TRATADORES.enviar_resposta(ctx(), { id: 0, tipo: "enviar_resposta", lane: "geral", payload: { mensagemId: outra!.id }, operador: "minha_conta", tentativas: 1, max_tentativas: 3 });
    expect((await um<{ status: string }>(db, "select status from mensagens where id = ?", [outra!.id]))?.status).toBe("fora_da_janela");
  });
});

describe.each(DIALETOS)("agendador ($nome)", ({ abrir }) => {
  it("ligar o modo envio coloca na fila os rascunhos feitos antes, uma vez só", async () => {
    const { db } = await abrir();
    const { agendar } = await import("../src/worker.ts");
    const config = { ...exemplo, modo: "envio" as const };
    const a = await criarLead(db, "lead.a", "x", { estado: "rascunho" });
    await criarLead(db, "lead.b", "x", { estado: "enviado" });
    await agendar(db, config);
    await agendar(db, config);
    const jobs = await db.todos<{ chave: string }>("select chave from jobs where tipo = 'enviar_dm'");
    expect(jobs.map((j) => j.chave)).toEqual([`enviar_dm:${a.id}:abertura`]);
    await agendar(db, { ...config, modo: "rascunho" });
    await db.fechar();
  });
});
