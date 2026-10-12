import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assinaturaValida, responder, type Gravar } from "../supabase/functions/receber-webhook/logica.ts";

const ambiente = { metaSegredo: "segredo-meta", metaTokenVerificacao: "token-verificacao", zernioSegredo: "segredo-zernio" };
const assinar = (corpo: string, segredo: string) => createHmac("sha256", segredo).update(corpo).digest("hex");
const URL_BASE = "https://exemplo.supabase.co/functions/v1/receber-webhook";

function gravador(): { gravar: Gravar; gravados: Array<[string, string]> } {
  const gravados: Array<[string, string]> = [];
  return { gravados, gravar: async (provedor, corpo) => void gravados.push([provedor, corpo]) };
}

describe("receptor de webhooks (Edge Function)", () => {
  it("responde o desafio da Meta só com o token certo", async () => {
    const { gravar } = gravador();
    const ok = await responder(new Request(`${URL_BASE}?provedor=meta&hub.mode=subscribe&hub.verify_token=token-verificacao&hub.challenge=123`), ambiente, gravar);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("123");
    const errado = await responder(new Request(`${URL_BASE}?provedor=meta&hub.mode=subscribe&hub.verify_token=outro&hub.challenge=123`), ambiente, gravar);
    expect(errado.status).toBe(403);
  });

  it("grava evento da Meta com X-Hub-Signature-256 válido e recusa o resto", async () => {
    const { gravar, gravados } = gravador();
    const corpo = JSON.stringify({ object: "instagram", entry: [] });
    const valido = await responder(new Request(`${URL_BASE}?provedor=meta`, { method: "POST", body: corpo, headers: { "x-hub-signature-256": `sha256=${assinar(corpo, "segredo-meta")}` } }), ambiente, gravar);
    expect(valido.status).toBe(200);
    const adulterado = await responder(new Request(`${URL_BASE}?provedor=meta`, { method: "POST", body: `${corpo} `, headers: { "x-hub-signature-256": `sha256=${assinar(corpo, "segredo-meta")}` } }), ambiente, gravar);
    expect(adulterado.status).toBe(401);
    const semAssinatura = await responder(new Request(`${URL_BASE}?provedor=meta`, { method: "POST", body: corpo }), ambiente, gravar);
    expect(semAssinatura.status).toBe(401);
    expect(gravados).toEqual([["meta", corpo]]);
  });

  it("grava evento da Zernio com x-zernio-signature e recusa assinatura de outro segredo", async () => {
    const { gravar, gravados } = gravador();
    const corpo = JSON.stringify({ event: "message.received" });
    expect((await responder(new Request(`${URL_BASE}?provedor=zernio`, { method: "POST", body: corpo, headers: { "x-zernio-signature": assinar(corpo, "segredo-zernio") } }), ambiente, gravar)).status).toBe(200);
    expect((await responder(new Request(`${URL_BASE}?provedor=zernio`, { method: "POST", body: corpo, headers: { "x-zernio-signature": assinar(corpo, "segredo-meta") } }), ambiente, gravar)).status).toBe(401);
    expect(gravados).toHaveLength(1);
  });

  it("sem segredo configurado recusa tudo; provedor desconhecido é 404", async () => {
    const corpo = "{}";
    expect(await assinaturaValida(corpo, assinar(corpo, "x"), undefined)).toBe(false);
    const { gravar } = gravador();
    expect((await responder(new Request(`${URL_BASE}?provedor=outro`, { method: "POST", body: corpo }), ambiente, gravar)).status).toBe(404);
  });
});
