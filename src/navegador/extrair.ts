// Leitura das páginas do Instagram sem depender do navegador: tudo aqui é função pura sobre texto,
// links e um "instantâneo" da página. Assim dá para testar com HTML de exemplo, sem Chrome.

export const ORIGEM_INSTAGRAM = "https://www.instagram.com";

const CAMINHO_USUARIO = /^\/([a-z0-9._]{1,30})\/?$/i;
const CAMINHO_POST = /^\/(?:[a-z0-9._]{1,30}\/)?(?:p|reel)\/[A-Za-z0-9_-]+\/?$/i;
const RESERVADOS = new Set([
  "about", "accounts", "ajax", "api", "challenge", "developer", "direct", "directory", "emails", "explore", "legal",
  "locations", "nametag", "oauth", "p", "press", "privacy", "reel", "reels", "session", "static", "stories", "tags",
  "terms", "web", "your_activity", "accounts_center", "guides", "lite", "linkshim", "popular",
]);

const LINHA_CONTADOR = /^\d[\d.,]*\s*(mil|mi|k|m)?\s*(posts?|publica|followers|seguidores|following|seguindo)/i;
const LINHA_RUIDO = /^(follow|seguir|following|seguindo|message|enviar mensagem|contact|contato|e-?mail|call|ligar|edit profile|editar perfil|view archive|ver arquivo|similar accounts|contas semelhantes|threads|options|opções|verified|verificado|posts?|publicações|followers|seguidores|\.{3}|•)$/i;
const TOKEN_NUMERO = String.raw`(\d[\d.,]*\s*(?:mil|mi|k|m)?)`;

const CAMINHO_LOGIN = /^\/accounts\/(login|emailsignup)/;
const CAMINHO_RESTRICAO = /^\/(challenge|accounts\/(suspended|disabled))/;
const TEXTO_RESTRICAO = /try again later|tente novamente mais tarde|action blocked|ação bloqueada|we limit how often|limitamos a frequência|restrict certain activity|restringimos certas atividades|suspicious|suspeita|confirm it.?s you|confirme que é você/i;
export const TEXTO_NAO_ENTREGAVEL = /não pode receber sua mensagem|nao pode receber sua mensagem|não aceita novas solicitações|nao aceita novas solicitacoes|can.?t receive your message|cannot receive your message|isn.?t accepting message requests|does not accept new message requests/i;
export const TEXTO_NAO_ENCONTRADO = /sorry, this page isn.t available|esta página não está disponível|página não está disponível/i;
export const TEXTO_PRIVADO = /esta conta é privada|this account is private/i;
export const TEXTO_SEM_POST = /ainda não há nenhuma publicação|nenhuma publicação ainda|no posts yet/i;

/** "1,234", "1.234", "12.5K", "12,5 mil", "1.2M", "1,2 mi". Separador sem sufixo é milhar. */
export function lerNumero(bruto: string | null | undefined): number | null {
  if (!bruto) return null;
  const m = bruto.trim().toLowerCase().match(/^(\d[\d.,]*)\s*(mil|mi|k|m)?$/);
  if (!m?.[1]) return null;
  const sufixo = m[2];
  const fator = sufixo === "k" || sufixo === "mil" ? 1_000 : sufixo === "m" || sufixo === "mi" ? 1_000_000 : 1;
  const valor = sufixo ? Number(m[1].replace(",", ".")) : Number(m[1].replace(/[.,]/g, ""));
  return Number.isFinite(valor) ? Math.round(valor * fator) : null;
}

function numeroAntes(texto: string, palavras: string): number | null {
  return lerNumero(texto.match(new RegExp(`${TOKEN_NUMERO}\\s*(?:${palavras})`, "i"))?.[1] ?? null);
}

/** og:description do perfil: "1.234 seguidores, 56 seguindo, 78 publicações - ... de Nome (@usuario)". */
export function lerDescricaoPerfil(descricao: string | null) {
  if (!descricao) return { seguidores: null, seguindo: null, posts: null, nome: null };
  const nome = descricao.match(/(?:from|de)\s+(.+?)\s*\(@[a-z0-9._]+\)\s*$/i);
  return {
    seguidores: numeroAntes(descricao, "followers|seguidores"),
    seguindo: numeroAntes(descricao, "following|seguindo"),
    posts: numeroAntes(descricao, "posts|publica"),
    nome: nome?.[1]?.trim() || null,
  };
}

function nomeDoTitulo(titulo: string | null): string | null {
  return titulo?.match(/^(.+?)\s*\(@[a-z0-9._]+\)/i)?.[1]?.trim() || null;
}

/** Texto do cabeçalho menos usuário, nome, contadores e rótulos de botão. */
export function extrairBio(textoCabecalho: string, usuario: string, nome: string | null): string | null {
  const pular = new Set([usuario.toLowerCase(), (nome ?? "").toLowerCase()]);
  const bio = textoCabecalho
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha && !pular.has(linha.toLowerCase()) && !LINHA_CONTADOR.test(linha) && !LINHA_RUIDO.test(linha) && !/^\d[\d.,]*\s*(mil|mi|k|m)?$/i.test(linha))
    .join("\n")
    .trim()
    .slice(0, 600);
  return bio || null;
}

function urls(hrefs: string[]): URL[] {
  const saida: URL[] = [];
  for (const href of hrefs) {
    try {
      saida.push(new URL(href, ORIGEM_INSTAGRAM));
    } catch {
      // href malformado: ignora
    }
  }
  return saida;
}

export function usuarioValido(usuario: string): boolean {
  return /^[a-z0-9._]{1,30}$/i.test(usuario) && !RESERVADOS.has(usuario.toLowerCase());
}

/** Usuários linkados na página (minúsculos, sem repetir, sem caminhos reservados). */
export function usuariosDosLinks(hrefs: string[]): string[] {
  const vistos = new Set<string>();
  for (const url of urls(hrefs)) {
    if (url.origin !== ORIGEM_INSTAGRAM) continue;
    const usuario = url.pathname.match(CAMINHO_USUARIO)?.[1]?.toLowerCase();
    if (usuario && !RESERVADOS.has(usuario)) vistos.add(usuario);
  }
  return [...vistos];
}

/** Caminhos de post e reel, na ordem da página. */
export function postsDosLinks(hrefs: string[]): string[] {
  const vistos = new Set<string>();
  for (const url of urls(hrefs)) {
    if (url.origin === ORIGEM_INSTAGRAM && CAMINHO_POST.test(url.pathname)) vistos.add(url.pathname);
  }
  return [...vistos];
}

/** Link da bio: o Instagram embrulha em l.instagram.com/?u=<destino>. */
export function linkExterno(hrefs: string[]): string | null {
  for (const url of urls(hrefs)) {
    if (url.hostname === "l.instagram.com") {
      const destino = url.searchParams.get("u");
      if (destino) return destino;
      continue;
    }
    if (url.origin !== ORIGEM_INSTAGRAM && /^https?:$/.test(url.protocol)) return url.toString();
  }
  return null;
}

export type ContaEncontrada = { usuario: string; nome: string | null; privada: boolean };

/** Resposta do endpoint da caixa de busca do Instagram. Formato inesperado devolve null. */
export function contasDaBusca(json: unknown, limite: number): ContaEncontrada[] | null {
  const users = (json as { users?: Array<{ user?: { username?: unknown; full_name?: unknown; is_private?: unknown } }> } | null)?.users;
  if (!Array.isArray(users)) return null;
  return users
    .map((item) => item.user)
    .filter((u): u is { username: string; full_name?: unknown; is_private?: unknown } => typeof u?.username === "string" && usuarioValido(u.username))
    .slice(0, limite)
    .map((u) => ({ usuario: u.username.toLowerCase(), nome: typeof u.full_name === "string" && u.full_name.trim() ? u.full_name.trim() : null, privada: u.is_private === true }));
}

export type Saude = "ok" | "sessao_perdida" | { restricao: string };

/** Página de login vira sessão perdida; desafio ou aviso de bloqueio vira restrição. */
export function diagnosticar(caminho: string, temCampoSenha: boolean, textoDialogos: string): Saude {
  if (CAMINHO_LOGIN.test(caminho) || temCampoSenha) return "sessao_perdida";
  if (CAMINHO_RESTRICAO.test(caminho)) return { restricao: `O Instagram pediu verificação em ${caminho}` };
  if (TEXTO_RESTRICAO.test(textoDialogos)) return { restricao: textoDialogos.trim().split("\n")[0]?.slice(0, 160) || "O Instagram bloqueou a ação" };
  return "ok";
}

/** Legenda e autor de um post a partir das metas (`Nome on Instagram: "legenda"`). */
export function lerPost(ogTitulo: string | null, ogDescricao: string | null, hrefsAutor: string[]) {
  const citado = (ogTitulo ?? "").match(/"([\s\S]+)"\s*$/) ?? (ogDescricao ?? "").match(/"([\s\S]+)"\s*$/);
  const legenda = (citado?.[1] ?? ogTitulo ?? ogDescricao ?? "").trim().slice(0, 300);
  const hashtags = [...new Set((legenda.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((tag) => tag.toLowerCase()))];
  const autorDescrito = ogDescricao?.match(/-\s*([a-z0-9._]{1,30})\s+(?:on|em)\s/i)?.[1]?.toLowerCase() ?? null;
  return { legenda, hashtags, autor: usuariosDosLinks(hrefsAutor)[0] ?? autorDescrito };
}

/** O que a página mostra, coletado de uma vez. Gerado por `instantaneo` dentro da página. */
export type Instantaneo = {
  caminho: string;
  ogDescricao: string | null;
  ogTitulo: string | null;
  textoCabecalho: string;
  linksCabecalho: string[];
  linksMain: string[];
  textoCorpo: string;
  temBotaoContato: boolean;
  temCampoSenha: boolean;
  textoDialogos: string;
};

/**
 * Roda DENTRO da página (page.evaluate) e também nos testes, com um DOM de mentira. Precisa ser
 * autocontida: nada de variável ou função de fora, porque o Playwright serializa só o corpo dela.
 * O texto vem nó a nó (uma linha por nó de texto) para não depender do layout do innerText.
 */
export function instantaneo(doc: Document): Instantaneo {
  const meta = (prop: string) => doc.querySelector(`meta[property="${prop}"]`)?.getAttribute("content") ?? null;
  const linhas = (raiz: Element | null): string => {
    if (!raiz) return "";
    const saida: string[] = [];
    const andar = (no: Node): void => {
      if (no.nodeType === 3) {
        const t = (no.textContent ?? "").trim();
        if (t) saida.push(t);
        return;
      }
      if (no.nodeType === 1 && ["SCRIPT", "STYLE"].includes((no as Element).tagName)) return;
      no.childNodes.forEach(andar);
    };
    andar(raiz);
    return saida.join("\n");
  };
  const hrefs = (seletor: string) => Array.from(doc.querySelectorAll(seletor)).map((a) => a.getAttribute("href") ?? "");
  const botoes = Array.from(doc.querySelectorAll('button, [role="button"], a')).map((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").trim());
  return {
    caminho: doc.location?.pathname ?? "/",
    ogDescricao: meta("og:description"),
    ogTitulo: meta("og:title"),
    textoCabecalho: linhas(doc.querySelector("header")),
    linksCabecalho: hrefs("header a[href]"),
    linksMain: hrefs("main a[href]"),
    textoCorpo: linhas(doc.body),
    temBotaoContato: botoes.some((t) => /^(Contato|Contact|E-?mail|Ligar|Call)$/i.test(t)),
    temCampoSenha: doc.querySelector('input[name="password"]') !== null,
    textoDialogos: Array.from(doc.querySelectorAll('[role="dialog"]')).map((d) => linhas(d)).join("\n"),
  };
}

export type PerfilPublico = {
  usuario: string;
  nome: string | null;
  bio: string | null;
  comercial: boolean;
  seguidores: number | null;
  seguindo: number | null;
  posts: number | null;
  linkExterno: string | null;
  legendas: string[];
  hashtags: string[];
};

/** Perfil a partir do instantâneo. As legendas dos posts entram depois, lidas post a post. */
export function interpretarPerfil(snap: Instantaneo, usuario: string): PerfilPublico {
  const desc = lerDescricaoPerfil(snap.ogDescricao);
  const nome = desc.nome ?? nomeDoTitulo(snap.ogTitulo);
  const bio = extrairBio(snap.textoCabecalho, usuario, nome);
  return {
    usuario,
    nome,
    bio,
    comercial: snap.temBotaoContato,
    seguidores: desc.seguidores,
    seguindo: desc.seguindo,
    posts: desc.posts,
    linkExterno: linkExterno(snap.linksCabecalho),
    legendas: [],
    hashtags: [...new Set((bio?.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((t) => t.toLowerCase()))],
  };
}
