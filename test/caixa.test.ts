import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { caixaMeta, caixaZernio, ErroDaCaixa, isoDaMeta } from "../src/caixa.ts";

type Pedido = { metodo: string; caminho: string; autorizacao: string | undefined; corpo: unknown };

/** Servidor falso: responde por rota e guarda o que recebeu. */
async function servidorFalso(rotas: Record<string, (p: Pedido) => [number, unknown]>): Promise<{ base: string; pedidos: Pedido[]; servidor: Server }> {
  const pedidos: Pedido[] = [];
  const servidor = createServer(async (req: IncomingMessage, res) => {
    let texto = "";
    for await (const parte of req) texto += parte;
    const url = new URL(req.url ?? "/", "http://x");
    const pedido = { metodo: req.method ?? "", caminho: url.pathname + url.search, autorizacao: req.headers.authorization, corpo: texto ? JSON.parse(texto) : null };
    pedidos.push(pedido);
    const rota = Object.keys(rotas).find((r) => `${req.method} ${url.pathname}` === r);
    const [status, corpo] = rota ? rotas[rota]!(pedido) : [404, { error: "rota" }];
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(corpo));
  });
  await new Promise<void>((r) => servidor.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`, pedidos, servidor };
}

let aberto: Server | undefined;
afterEach(() => aberto?.close());

describe("Zernio", () => {
  it("lista só conversas de leads, lê mensagens e envia resposta", async () => {
    const falso = await servidorFalso({
      "GET /inbox/conversations": () => [200, { conversations: [{ id: "c1", participantId: "p1", participantUsername: "@Lead.Um" }, { id: "c2", participantId: "p2", participantUsername: "estranho" }] }],
      "GET /inbox/conversations/c1/messages": () => [200, { messages: [{ id: "m1", message: "oi!", direction: "incoming", sentAt: "2026-10-12T12:00:00.000Z" }, { id: "m2", message: "", direction: "incoming" }, { id: "m3", message: "olá", direction: "outgoing", sentAt: "2026-10-12T11:00:00.000Z" }] }],
      "POST /inbox/conversations/c1/messages": () => [200, { id: "enviada" }],
    });
    aberto = falso.servidor;
    const caixa = caixaZernio({ chave: "chave-teste", conta: "conta1", base: falso.base });
    const conversas = await caixa.listar(new Set(["lead.um"]));
    expect(conversas).toEqual([
      {
        conversaId: "c1",
        contatoId: "p1",
        usuario: "lead.um",
        mensagens: [
          { id: "m1", texto: "oi!", entrada: true, em: "2026-10-12T12:00:00.000Z" },
          { id: "m3", texto: "olá", entrada: false, em: "2026-10-12T11:00:00.000Z" },
        ],
      },
    ]);
    expect(falso.pedidos.some((p) => p.caminho.includes("/c2/"))).toBe(false);
    await caixa.enviar({ conversaId: "c1", contatoId: "p1" }, "resposta");
    const envio = falso.pedidos.at(-1)!;
    expect(envio).toMatchObject({ metodo: "POST", autorizacao: "Bearer chave-teste", corpo: { accountId: "conta1", message: "resposta" } });
  });

  it("classifica janela fechada e recusa texto acima de 1000 bytes sem chamar a API", async () => {
    const falso = await servidorFalso({ "POST /inbox/conversations/c1/messages": () => [400, { error: "Outside the 24-hour messaging window" }] });
    aberto = falso.servidor;
    const caixa = caixaZernio({ chave: "k", conta: "c", base: falso.base });
    await expect(caixa.enviar({ conversaId: "c1", contatoId: "" }, "oi")).rejects.toMatchObject({ tipo: "janela_fechada", status: 400 });
    await expect(caixa.enviar({ conversaId: "c1", contatoId: "" }, "ã".repeat(600))).rejects.toThrow(ErroDaCaixa);
    expect(falso.pedidos).toHaveLength(1);
  });
});

describe("Meta (Graph do Instagram)", () => {
  it("lista conversas, separa o que é meu do que é do contato e envia pelo id do contato", async () => {
    const falso = await servidorFalso({
      "GET /v26.0/me/conversations": () => [
        200,
        {
          data: [
            {
              id: "conv1",
              participants: { data: [{ id: "eu1", username: "minha_conta" }, { id: "igsid9", username: "lead.um" }] },
              messages: { data: [{ id: "x2", message: "quero saber mais", created_time: "2026-10-12T15:00:00+0000", from: { id: "igsid9", username: "lead.um" } }, { id: "x1", message: "oi", created_time: "2026-10-12T14:00:00+0000", from: { id: "eu1", username: "minha_conta" } }] },
            },
            { id: "conv2", participants: { data: [{ id: "eu1", username: "minha_conta" }, { id: "z", username: "outro" }] } },
          ],
        },
      ],
      "POST /v26.0/me/messages": () => [200, { recipient_id: "igsid9", message_id: "mid" }],
    });
    aberto = falso.servidor;
    const caixa = caixaMeta({ token: "token-teste", minhaConta: "Minha_Conta", base: falso.base });
    const [conversa] = await caixa.listar(new Set(["lead.um"]));
    expect(conversa).toMatchObject({ conversaId: "conv1", contatoId: "igsid9", usuario: "lead.um" });
    expect(conversa!.mensagens).toEqual([
      { id: "x2", texto: "quero saber mais", entrada: true, em: "2026-10-12T15:00:00.000Z" },
      { id: "x1", texto: "oi", entrada: false, em: "2026-10-12T14:00:00.000Z" },
    ]);
    await caixa.enviar({ conversaId: "conv1", contatoId: "igsid9" }, "claro!");
    expect(falso.pedidos.at(-1)).toMatchObject({ autorizacao: "Bearer token-teste", corpo: { recipient: { id: "igsid9" }, message: { text: "claro!" } } });
    expect(falso.pedidos[0]!.caminho).not.toContain("token-teste");
  });

  it("classifica token vencido, limite e janela de 24 h pelos códigos da Meta", async () => {
    let erro: unknown = { error: { code: 190, message: "token" } };
    const falso = await servidorFalso({ "POST /v26.0/me/messages": () => [400, erro] });
    aberto = falso.servidor;
    const caixa = caixaMeta({ token: "t", minhaConta: "eu", base: falso.base });
    await expect(caixa.enviar({ conversaId: "", contatoId: "1" }, "a")).rejects.toMatchObject({ tipo: "auth" });
    erro = { error: { code: 613, message: "limite" } };
    await expect(caixa.enviar({ conversaId: "", contatoId: "1" }, "a")).rejects.toMatchObject({ tipo: "limite" });
    erro = { error: { code: 10, error_subcode: 2534022, message: "janela" } };
    await expect(caixa.enviar({ conversaId: "", contatoId: "1" }, "a")).rejects.toMatchObject({ tipo: "janela_fechada" });
  });

  it("converte a data da Meta para ISO", () => {
    expect(isoDaMeta("2026-01-01T12:00:00+0000")).toBe("2026-01-01T12:00:00.000Z");
  });
});
