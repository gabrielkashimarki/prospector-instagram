import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Banco, criarLead, lerLead, reservarLead } from "../src/db.ts";
import { adiar, enfileirar, esperaDeRetentativa, falhar, pegarProximo, recuperarTravados } from "../src/fila.ts";
import { DIALETOS } from "./bancos.ts";

describe.each(DIALETOS)("fila e deduplicação ($nome)", ({ abrir }) => {
  let db: Banco;
  let outraConexao: () => Promise<Banco>;
  beforeEach(async () => ({ db, outraConexao } = await abrir()));
  afterEach(async () => db.fechar());

  const passado = "2020-01-01T00:00:00.000Z";

  it("a mesma chave enfileira uma vez só", async () => {
    expect(await enfileirar(db, "ler_perfil", { leadId: 1 }, { chave: "ler_perfil:1" })).toBeTypeOf("number");
    expect(await enfileirar(db, "ler_perfil", { leadId: 1 }, { chave: "ler_perfil:1" })).toBeNull();
  });

  it("pega por lane, prioridade e horário, e não pega o que é de outro operador", async () => {
    await enfileirar(db, "qualificar", { leadId: 9 }, { executarEm: passado });
    await enfileirar(db, "descobrir", { fonte: "busca", valor: "a" }, { prioridade: 10, executarEm: passado });
    await enfileirar(db, "ler_perfil", { leadId: 2 }, { prioridade: 20, executarEm: passado });
    await enfileirar(db, "ler_perfil", { leadId: 3 }, { prioridade: 99, executarEm: "2999-01-01T00:00:00.000Z" });
    await enfileirar(db, "verificar_resposta", { leadId: 4 }, { prioridade: 50, executarEm: passado, operador: "outra" });
    const primeiro = await pegarProximo(db, "navegador", "eu");
    expect(primeiro).toMatchObject({ tipo: "ler_perfil", payload: { leadId: 2 }, tentativas: 1 });
    expect((await pegarProximo(db, "navegador", "eu"))?.tipo).toBe("descobrir");
    expect(await pegarProximo(db, "navegador", "eu")).toBeNull();
    expect((await pegarProximo(db, "navegador", "outra"))?.payload).toEqual({ leadId: 4 });
    expect((await pegarProximo(db, "geral", "eu"))?.tipo).toBe("qualificar");
  });

  it("adiar não gasta tentativa; falhar gasta e morre no fim", async () => {
    await enfileirar(db, "ler_perfil", { leadId: 1 }, { executarEm: passado });
    let job = (await pegarProximo(db, "navegador", "eu"))!;
    await adiar(db, job.id, 1, "teste", passado);
    job = (await pegarProximo(db, "navegador", "eu", "2020-01-01T00:00:05.000Z"))!;
    expect(job.tentativas).toBe(1);
    expect(await falhar(db, job, new Error("x"), passado)).toBe("retentar");
    job = (await pegarProximo(db, "navegador", "eu", "2020-01-01T01:00:00.000Z"))!;
    expect(job.tentativas).toBe(2);
    expect(await falhar(db, job, new Error("x"), passado)).toBe("retentar");
    job = (await pegarProximo(db, "navegador", "eu", "2020-01-01T02:00:00.000Z"))!;
    expect(await falhar(db, job, new Error("fim"), passado)).toBe("morto");
    expect(await pegarProximo(db, "navegador", "eu", "2030-01-01T00:00:00.000Z")).toBeNull();
  });

  it("espera de retentativa cresce e tem teto", () => {
    expect([1, 2, 3, 10].map(esperaDeRetentativa)).toEqual([30, 60, 120, 3600]);
  });

  it("depois de queda, solta o que era meu e o que travou há muito tempo", async () => {
    await enfileirar(db, "ler_perfil", { leadId: 1 }, { executarEm: passado });
    await enfileirar(db, "ler_perfil", { leadId: 2 }, { executarEm: passado });
    await pegarProximo(db, "navegador", "eu");
    await pegarProximo(db, "navegador", "outra");
    expect(await recuperarTravados(db, "eu")).toBe(1);
    expect(await recuperarTravados(db, "eu", "2999-01-01T00:00:00.000Z")).toBe(1);
  });

  it("duas conexões puxando a fila ao mesmo tempo nunca pegam o mesmo trabalho", async () => {
    for (let i = 0; i < 30; i += 1) await enfileirar(db, "ler_perfil", { leadId: i }, { executarEm: passado });
    const outra = await outraConexao();
    const pegos: number[] = [];
    const puxar = async (conexao: Banco, operador: string) => {
      for (;;) {
        const job = await pegarProximo(conexao, "navegador", operador);
        if (!job) return;
        pegos.push(job.id);
      }
    };
    await Promise.all([puxar(db, "a"), puxar(outra, "b"), puxar(db, "c")]);
    await outra.fechar();
    expect(pegos).toHaveLength(30);
    expect(new Set(pegos).size).toBe(30);
  });

  it("um @ vira um lead só, mesmo vindo de buscas diferentes", async () => {
    const a = await criarLead(db, "perfil.um", "busca:x");
    const b = await criarLead(db, "perfil.um", "hashtag:y");
    expect(a.novo).toBe(true);
    expect(b).toEqual({ id: a.id, novo: false });
    expect((await lerLead(db, a.id))?.origem).toBe("busca:x");
  });

  it("só um operador consegue reservar o lead para a DM", async () => {
    const { id } = await criarLead(db, "perfil.um", "busca:x", { estado: "rascunho" });
    const outra = await outraConexao();
    const resultados = await Promise.all([reservarLead(db, id, "rascunho", "a"), reservarLead(outra, id, "rascunho", "b")]);
    await outra.fechar();
    expect(resultados.filter(Boolean)).toHaveLength(1);
    expect((await lerLead(db, id))?.estado).toBe("enviando");
    expect(await reservarLead(db, id, "rascunho", "a")).toBe(false);
  });
});
