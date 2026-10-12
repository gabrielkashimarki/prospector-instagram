// Lógica do receptor de webhooks, sem nada de Deno nem de Supabase: roda igual na Edge Function e
// nos testes (Node). Valida a assinatura, responde o desafio da Meta e entrega o corpo para gravar.

export type Ambiente = {
  /** App secret do app da Meta (assina o X-Hub-Signature-256). */
  metaSegredo?: string;
  /** Texto que você inventa e cola no painel da Meta ao cadastrar o webhook. */
  metaTokenVerificacao?: string;
  /** Segredo do webhook cadastrado na Zernio (assina o x-zernio-signature). */
  zernioSegredo?: string;
};

export type Gravar = (provedor: "meta" | "zernio", corpo: string) => Promise<void>;

async function hmacHex(segredo: string, corpo: string): Promise<string> {
  const chave = await crypto.subtle.importKey("raw", new TextEncoder().encode(segredo), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const assinatura = await crypto.subtle.sign("HMAC", chave, new TextEncoder().encode(corpo));
  return Array.from(new Uint8Array(assinatura), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Comparação em tempo constante: não revela, pelo tempo de resposta, quantos caracteres bateram. */
function iguais(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diferenca = 0;
  for (let i = 0; i < a.length; i += 1) diferenca |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferenca === 0;
}

/** HMAC-SHA256 do corpo cru. Sem segredo configurado, recusa tudo. */
export async function assinaturaValida(corpo: string, cabecalho: string | null, segredo: string | undefined): Promise<boolean> {
  if (!segredo || !cabecalho) return false;
  return iguais(await hmacHex(segredo, corpo), cabecalho.replace(/^sha256=/i, "").toLowerCase());
}

const LIMITE_BYTES = 1_000_000;

/** Provedor vem na URL: .../receber-webhook?provedor=meta ou ?provedor=zernio. */
export async function responder(req: Request, ambiente: Ambiente, gravar: Gravar): Promise<Response> {
  const url = new URL(req.url);
  const provedor = url.searchParams.get("provedor");
  if (provedor !== "meta" && provedor !== "zernio") return new Response("provedor desconhecido", { status: 404 });

  if (req.method === "GET") {
    // Desafio de verificação que a Meta faz ao cadastrar o webhook.
    const ok =
      provedor === "meta" &&
      Boolean(ambiente.metaTokenVerificacao) &&
      url.searchParams.get("hub.mode") === "subscribe" &&
      url.searchParams.get("hub.verify_token") === ambiente.metaTokenVerificacao;
    return ok ? new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 }) : new Response("", { status: 403 });
  }
  if (req.method !== "POST") return new Response("", { status: 405 });

  const corpo = await req.text();
  if (new TextEncoder().encode(corpo).length > LIMITE_BYTES) return new Response("", { status: 413 });
  const valido =
    provedor === "meta"
      ? await assinaturaValida(corpo, req.headers.get("x-hub-signature-256"), ambiente.metaSegredo)
      : await assinaturaValida(corpo, req.headers.get("x-zernio-signature"), ambiente.zernioSegredo);
  if (!valido) return new Response("", { status: 401 });
  try {
    JSON.parse(corpo);
  } catch {
    return new Response("", { status: 400 });
  }
  await gravar(provedor, corpo);
  return Response.json({ ok: true });
}
