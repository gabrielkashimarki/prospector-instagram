// Caixa de entrada por integração oficial, depois que a primeira DM saiu pelo Chrome:
// Zernio (API de terceiros) ou app próprio da Meta (Instagram API com login do Instagram).
// Por padrão é sincronização periódica. No modo nuvem, o webhook (Edge Function do Supabase) só
// avisa que chegou coisa nova e antecipa a sincronização; o conteúdo é sempre lido pela API.

const TIMEOUT_MS = 30_000;
export const LIMITE_BYTES_DM = 1000;

export type MensagemDaCaixa = { id: string; texto: string; entrada: boolean; em: string };
export type ConversaDaCaixa = { conversaId: string; contatoId: string; usuario: string; mensagens: MensagemDaCaixa[] };

export type Caixa = {
  /** Conversas recentes. `usuariosDeInteresse` evita buscar mensagens de quem não é lead. */
  listar(usuariosDeInteresse: Set<string>): Promise<ConversaDaCaixa[]>;
  enviar(conversa: { conversaId: string; contatoId: string }, texto: string): Promise<void>;
};

export class ErroDaCaixa extends Error {
  readonly status: number;
  readonly tipo: "auth" | "limite" | "janela_fechada" | "outro";
  constructor(mensagem: string, status: number, tipo: ErroDaCaixa["tipo"]) {
    super(mensagem);
    this.name = "ErroDaCaixa";
    this.status = status;
    this.tipo = tipo;
  }
}

async function pedir(url: string, init: { method: "GET" | "POST"; token: string; corpo?: unknown }, classificar: (status: number, corpo: Record<string, unknown>) => ErroDaCaixa["tipo"]): Promise<Record<string, unknown>> {
  const resposta = await fetch(url, {
    method: init.method,
    headers: { authorization: `Bearer ${init.token}`, accept: "application/json", ...(init.corpo ? { "content-type": "application/json" } : {}) },
    body: init.corpo ? JSON.stringify(init.corpo) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const texto = await resposta.text();
  let json: Record<string, unknown>;
  try {
    json = texto ? (JSON.parse(texto) as Record<string, unknown>) : {};
  } catch {
    json = { bruto: texto };
  }
  if (!resposta.ok) {
    const erro = (json.error && typeof json.error === "object" ? (json.error as Record<string, unknown>).message : json.error) ?? json.message ?? `HTTP ${resposta.status}`;
    throw new ErroDaCaixa(String(erro), resposta.status, classificar(resposta.status, json));
  }
  return json;
}

function checarTamanho(texto: string): void {
  if (Buffer.byteLength(texto, "utf8") > LIMITE_BYTES_DM) throw new ErroDaCaixa(`Mensagem passa de ${LIMITE_BYTES_DM} bytes, limite do Instagram`, 400, "outro");
}

// ---------------------------------------------------------------- Zernio

export function caixaZernio(opcoes: { chave: string; conta: string; base?: string }): Caixa {
  const base = (opcoes.base ?? "https://zernio.com/api/v1").replace(/\/+$/, "");
  const classificar = (status: number, corpo: Record<string, unknown>): ErroDaCaixa["tipo"] => {
    const msg = String(corpo.error ?? corpo.message ?? "").toLowerCase();
    if (status === 401) return "auth";
    if (status === 429) return "limite";
    if (status === 400 && (msg.includes("24-hour") || msg.includes("window"))) return "janela_fechada";
    return "outro";
  };
  return {
    async listar(interesse) {
      const url = new URL(`${base}/inbox/conversations`);
      url.searchParams.set("accountId", opcoes.conta);
      url.searchParams.set("limit", "50");
      const r = await pedir(url.toString(), { method: "GET", token: opcoes.chave }, classificar);
      const conversas = (r.conversations ?? r.data ?? []) as Array<{ id: string; participantId?: string; participantUsername?: string }>;
      const saida: ConversaDaCaixa[] = [];
      for (const c of conversas) {
        const usuario = (c.participantUsername ?? "").trim().replace(/^@/, "").toLowerCase();
        if (!usuario || !interesse.has(usuario)) continue;
        const urlMsg = new URL(`${base}/inbox/conversations/${encodeURIComponent(c.id)}/messages`);
        urlMsg.searchParams.set("accountId", opcoes.conta);
        urlMsg.searchParams.set("limit", "20");
        const m = await pedir(urlMsg.toString(), { method: "GET", token: opcoes.chave }, classificar);
        const mensagens = (m.messages ?? m.data ?? []) as Array<{ id: string; message?: string; direction?: string; sentAt?: string }>;
        saida.push({
          conversaId: c.id,
          contatoId: c.participantId ?? "",
          usuario,
          mensagens: mensagens.filter((x) => x.message?.trim()).map((x) => ({ id: x.id, texto: x.message!.trim(), entrada: x.direction === "incoming", em: x.sentAt ?? new Date().toISOString() })),
        });
      }
      return saida;
    },
    async enviar(conversa, texto) {
      checarTamanho(texto);
      await pedir(`${base}/inbox/conversations/${encodeURIComponent(conversa.conversaId)}/messages`, { method: "POST", token: opcoes.chave, corpo: { accountId: opcoes.conta, message: texto } }, classificar);
    },
  };
}

// ---------------------------------------------------------------- Meta (Instagram API com login do Instagram)

/** A Meta manda `2026-01-01T12:00:00+0000`; o resto do projeto compara ISO com `Z`. */
export function isoDaMeta(valor: unknown): string {
  const data = typeof valor === "string" ? new Date(valor.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")) : new Date(Number.NaN);
  return Number.isNaN(data.getTime()) ? new Date().toISOString() : data.toISOString();
}

export function caixaMeta(opcoes: { token: string; minhaConta: string; base?: string; versao?: string }): Caixa {
  const base = `${(opcoes.base ?? "https://graph.instagram.com").replace(/\/+$/, "")}/${opcoes.versao ?? "v26.0"}`;
  const eu = opcoes.minhaConta.toLowerCase();
  // Códigos da lista de erros de mensagens da Meta: 190 token, 4/17/32/613 limite, 10/2534022 fora das 24 h.
  const classificar = (status: number, corpo: Record<string, unknown>): ErroDaCaixa["tipo"] => {
    const erro = (corpo.error ?? {}) as { code?: number; error_subcode?: number };
    if (erro.code === 190 || status === 401) return "auth";
    if ([4, 17, 32, 613].includes(erro.code ?? -1) || status === 429) return "limite";
    if (erro.code === 10 && erro.error_subcode === 2534022) return "janela_fechada";
    return "outro";
  };
  return {
    async listar(interesse) {
      const url = `${base}/me/conversations?platform=instagram&fields=${encodeURIComponent("participants,messages.limit(20){id,from,message,created_time}")}`;
      const r = await pedir(url, { method: "GET", token: opcoes.token }, classificar);
      const saida: ConversaDaCaixa[] = [];
      for (const c of (r.data ?? []) as Array<{ id: string; participants?: { data?: Array<{ id: string; username?: string }> }; messages?: { data?: Array<{ id: string; message?: string; created_time?: string; from?: { id?: string; username?: string } }> } }>) {
        const contato = c.participants?.data?.find((p) => (p.username ?? "").toLowerCase() !== eu);
        const usuario = (contato?.username ?? "").toLowerCase();
        if (!contato || !usuario || !interesse.has(usuario)) continue;
        saida.push({
          conversaId: c.id,
          contatoId: contato.id,
          usuario,
          mensagens: (c.messages?.data ?? [])
            .filter((m) => m.message?.trim())
            .map((m) => ({ id: m.id, texto: m.message!.trim(), entrada: (m.from?.username ?? "").toLowerCase() !== eu, em: isoDaMeta(m.created_time) })),
        });
      }
      return saida;
    },
    async enviar(conversa, texto) {
      checarTamanho(texto);
      await pedir(`${base}/me/messages`, { method: "POST", token: opcoes.token, corpo: { recipient: { id: conversa.contatoId }, message: { text: texto } } }, classificar);
    },
  };
}
