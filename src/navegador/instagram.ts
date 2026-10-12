// Ações no Instagram pelo navegador. A leitura das páginas está em extrair.ts (testada com HTML de
// exemplo); aqui fica só o que precisa de Chrome: navegar, esperar, clicar e digitar.

import type { Locator, Page, Response } from "playwright-core";
import { sortear } from "../ritmo.ts";
import { DmIndisponivel, DmNaoEntregavel, PerfilNaoEncontrado, RestricaoDoInstagram, SessaoPerdida } from "./erros.ts";
import {
  contasDaBusca,
  diagnosticar,
  instantaneo,
  interpretarPerfil,
  lerPost,
  ORIGEM_INSTAGRAM,
  postsDosLinks,
  TEXTO_NAO_ENCONTRADO,
  TEXTO_NAO_ENTREGAVEL,
  TEXTO_PRIVADO,
  TEXTO_SEM_POST,
  usuariosDosLinks,
  type ContaEncontrada,
  type Instantaneo,
  type PerfilPublico,
} from "./extrair.ts";

/** Ritmo de leitura e digitação em milissegundos. Protege a conta; não serve para disfarçar automação. */
const RITMO = { letra: [60, 170], palavra: [120, 420], leitura: [1200, 3200], antesDeEnviar: [1500, 3800] } as const;

const BOTAO_MENSAGEM = /^(Enviar mensagem|Message)$/i;
const BOTAO_ENVIAR = /^(Enviar|Send)$/i;
const CAIXA_MENSAGEM = /^(Mensagem|Message)/i;
const BOTAO_DISPENSAR = /^(Agora não|Not now)$/i;
/** Folha que o Instagram põe na frente ao abordar quem não te segue. Sem o clique a caixa não abre. */
const BOTAO_MENSAGEM_PRIORITARIA = /^(Enviar mensagem priorit[áa]ria|Send priority message)$/i;
const BOTAO_CURTIR = /^(Curtir|Like)$/i;
const BOTAO_DESCURTIR = /^(Descurtir|Unlike)$/i;
const BOTAO_COMENTAR = /^(Comentar|Comment)$/i;
const ID_APP_WEB = "936619743392459";

function dormir(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pausa(faixa: readonly [number, number]): Promise<void> {
  return dormir(sortear(faixa[0], faixa[1]));
}

async function foto(page: Page): Promise<Instantaneo> {
  return await page.evaluate(instantaneo, await page.evaluateHandle(() => document));
}

/** Sessão perdida ou restrição viram erro na hora. */
async function checarSaude(page: Page): Promise<void> {
  const snap = await foto(page).catch(() => null);
  const caminho = new URL(page.url()).pathname;
  const saude = diagnosticar(caminho, snap?.temCampoSenha ?? false, snap?.textoDialogos ?? "");
  if (saude === "sessao_perdida") throw new SessaoPerdida();
  if (saude !== "ok") throw new RestricaoDoInstagram(saude.restricao);
}

/** Toda navegação fica no instagram.com. Qualquer outro destino é recusado. */
async function navegar(page: Page, caminho: string): Promise<Response | null> {
  const url = new URL(caminho, ORIGEM_INSTAGRAM);
  if (url.origin !== ORIGEM_INSTAGRAM) throw new Error(`Navegação recusada fora do Instagram: ${url}`);
  const resposta = await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
  if (page.url() !== "about:blank" && new URL(page.url()).origin !== ORIGEM_INSTAGRAM) throw new Error(`O Instagram redirecionou para fora: ${page.url()}`);
  await checarSaude(page);
  return resposta;
}

async function abrirPerfil(page: Page, usuario: string): Promise<void> {
  const resposta = await navegar(page, `/${usuario}/`);
  if (resposta?.status() === 404) throw new PerfilNaoEncontrado(usuario);
  const corpo = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  if (TEXTO_NAO_ENCONTRADO.test(corpo)) throw new PerfilNaoEncontrado(usuario);
  await pausa(RITMO.leitura);
  const dispensar = page.getByRole("button", { name: BOTAO_DISPENSAR }).first();
  if (await dispensar.isVisible().catch(() => false)) await dispensar.click({ timeout: 3_000 }).catch(() => undefined);
}

/** Resultado renderiza no cliente: espera até 10 s pelo primeiro link de perfil ou post. */
async function linksDaPagina(page: Page): Promise<string[]> {
  const prazo = Date.now() + 10_000;
  for (;;) {
    const hrefs = await page.locator("a[href]").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
    if (usuariosDosLinks(hrefs).length > 0 || postsDosLinks(hrefs).length > 0 || Date.now() > prazo) return hrefs;
    await dormir(500);
  }
}

async function autorDoPost(page: Page, caminho: string): Promise<string | null> {
  try {
    await navegar(page, caminho);
    const snap = await foto(page);
    return lerPost(snap.ogTitulo, snap.ogDescricao, snap.linksMain).autor;
  } catch (erro) {
    if (erro instanceof SessaoPerdida || erro instanceof RestricaoDoInstagram) throw erro;
    return null;
  }
}

/** Página da hashtag: perfis linkados e, como ela mostra mais posts que perfis, o autor de alguns posts. */
export async function buscarHashtag(page: Page, hashtag: string, limite: number): Promise<string[]> {
  await navegar(page, `/explore/tags/${encodeURIComponent(hashtag.trim().replace(/^#/, ""))}/`);
  await pausa(RITMO.leitura);
  let hrefs = await linksDaPagina(page);
  await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2)).catch(() => undefined);
  await pausa(RITMO.leitura);
  hrefs = [...hrefs, ...(await page.locator("a[href]").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? "")))];
  const achados = usuariosDosLinks(hrefs);
  for (const post of postsDosLinks(hrefs).slice(0, 8)) {
    if (achados.length >= limite) break;
    await pausa(RITMO.leitura);
    const autor = await autorDoPost(page, post);
    if (autor && !achados.includes(autor)) achados.push(autor);
  }
  return achados.slice(0, limite);
}

/** Busca de contas pelo mesmo endpoint da caixa de busca do Instagram (devolve perfis, não posts). */
export async function buscarContas(page: Page, termo: string, limite: number): Promise<ContaEncontrada[]> {
  await navegar(page, "/");
  await pausa(RITMO.leitura);
  const caminho = `/web/search/topsearch/?context=user&query=${encodeURIComponent(termo.trim())}`;
  const json = await page
    .evaluate(
      async ([url, app]) => {
        const r = await fetch(url as string, { headers: { "x-ig-app-id": app as string, "x-requested-with": "XMLHttpRequest" }, credentials: "include" });
        return r.ok ? ((await r.json()) as unknown) : null;
      },
      [caminho, ID_APP_WEB],
    )
    .catch(() => null);
  const contas = contasDaBusca(json, limite);
  if (contas) return contas;
  // O endpoint mudou: cai na busca por palavra-chave e lê os autores dos posts.
  await navegar(page, `/explore/search/keyword/?q=${encodeURIComponent(termo.trim())}`);
  const hrefs = await linksDaPagina(page);
  const achados = usuariosDosLinks(hrefs);
  for (const post of postsDosLinks(hrefs).slice(0, 4)) {
    if (achados.length >= limite) break;
    await pausa(RITMO.leitura);
    const autor = await autorDoPost(page, post);
    if (autor && !achados.includes(autor)) achados.push(autor);
  }
  return achados.slice(0, limite).map((usuario) => ({ usuario, nome: null, privada: false }));
}

/** Perfil público e a legenda de até `maxPosts` posts. */
export async function lerPerfil(page: Page, usuario: string, maxPosts = 3): Promise<PerfilPublico> {
  await abrirPerfil(page, usuario);
  const snap = await foto(page);
  const perfil = interpretarPerfil(snap, usuario);
  for (const post of postsDosLinks(snap.linksMain).slice(0, maxPosts)) {
    await pausa(RITMO.leitura);
    try {
      await navegar(page, post);
      const p = await foto(page);
      const lido = lerPost(p.ogTitulo, p.ogDescricao, p.linksMain);
      if (lido.legenda) perfil.legendas.push(lido.legenda);
      perfil.hashtags = [...new Set([...perfil.hashtags, ...lido.hashtags])];
    } catch (erro) {
      // Post apagado não derruba a leitura do perfil inteiro.
      if (erro instanceof SessaoPerdida || erro instanceof RestricaoDoInstagram) throw erro;
    }
  }
  return perfil;
}

export type ResultadoCurtida = "curtiu" | "ja_curtido" | "sem_post" | "privado";

/** Curte o post mais recente, pulando os fixados. O coração vem da barra do post, nunca de um comentário. */
export async function curtirUltimoPost(page: Page, usuario: string): Promise<ResultadoCurtida> {
  await abrirPerfil(page, usuario);
  const texto = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  if (TEXTO_PRIVADO.test(texto)) return "privado";
  if (TEXTO_SEM_POST.test(texto)) return "sem_post";
  // O grid carrega depois do texto: ler cedo dava "sem post" falso.
  const carregou = await page.locator('main a[href*="/p/"], main a[href*="/reel/"]').first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
  if (!carregou) {
    await checarSaude(page);
    throw new Error(`O grid do perfil @${usuario} não carregou`);
  }
  const grade = await page.locator("main a[href]").evaluateAll((as) =>
    as.map((a) => ({ href: a.getAttribute("href") ?? "", fixado: Array.from(a.querySelectorAll("[aria-label], title")).some((el) => /fixad|pinned/i.test(el.getAttribute("aria-label") ?? el.textContent ?? "")) })),
  );
  const posts = grade.filter((g) => postsDosLinks([g.href]).length > 0);
  const alvo = posts.find((p) => !p.fixado) ?? posts[0];
  if (!alvo) return "sem_post";
  await pausa(RITMO.leitura);
  await navegar(page, postsDosLinks([alvo.href])[0]!);
  await pausa(RITMO.leitura);
  const barra = page.locator("section", { has: page.getByRole("button", { name: BOTAO_COMENTAR }) }).first();
  if (await barra.getByRole("button", { name: BOTAO_DESCURTIR }).first().isVisible().catch(() => false)) return "ja_curtido";
  const curtir = barra.getByRole("button", { name: BOTAO_CURTIR }).first();
  if (!(await curtir.isVisible().catch(() => false))) {
    await checarSaude(page);
    throw new Error(`Botão Curtir não encontrado no post de @${usuario}`);
  }
  await pausa(RITMO.antesDeEnviar);
  await curtir.click({ timeout: 10_000 });
  const confirmou = await barra.getByRole("button", { name: BOTAO_DESCURTIR }).first().waitFor({ timeout: 10_000 }).then(() => true, () => false);
  await checarSaude(page);
  if (!confirmou) throw new Error(`A curtida no post de @${usuario} não confirmou`);
  return "curtiu";
}

async function aceitarMensagemPrioritaria(page: Page): Promise<boolean> {
  const botao = page.getByRole("button", { name: BOTAO_MENSAGEM_PRIORITARIA }).first();
  if (!(await botao.isVisible().catch(() => false))) return false;
  await botao.click({ timeout: 5_000 }).catch(() => undefined);
  return true;
}

/** Abre a conversa pelo botão do perfil. Tenta o clique até 3 vezes: às vezes a janela só abre na segunda. */
async function abrirConversa(page: Page, usuario: string): Promise<Locator> {
  await abrirPerfil(page, usuario);
  const botao = page.getByRole("button", { name: BOTAO_MENSAGEM }).or(page.getByRole("link", { name: BOTAO_MENSAGEM })).first();
  try {
    await botao.click({ timeout: 10_000 });
  } catch {
    await checarSaude(page);
    throw new DmIndisponivel(`O perfil @${usuario} não oferece o botão de mensagem`);
  }
  // A janela de conversa expõe a caixa sem nome acessível, só com placeholder: o seletor genérico é o reserva.
  const caixa = page.getByRole("textbox", { name: CAIXA_MENSAGEM }).or(page.getByPlaceholder(CAIXA_MENSAGEM)).or(page.locator('[role="textbox"][contenteditable="true"]')).last();
  let abriu = false;
  for (let tentativa = 0; tentativa < 3 && !abriu; tentativa += 1) {
    if (tentativa > 0) {
      await dormir(2_000);
      await checarSaude(page);
      if (await botao.isVisible().catch(() => false)) await botao.click({ timeout: 10_000 }).catch(() => undefined);
    }
    await aceitarMensagemPrioritaria(page);
    abriu = await caixa.waitFor({ state: "visible", timeout: tentativa === 0 ? 8_000 : 15_000 }).then(() => true, () => false);
  }
  if (!abriu) {
    await checarSaude(page);
    throw new DmIndisponivel(`A caixa de mensagem de @${usuario} não abriu`, true);
  }
  await checarSaude(page);
  return caixa;
}

async function checarEntregavel(page: Page, usuario: string): Promise<void> {
  const texto = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  if (TEXTO_NAO_ENTREGAVEL.test(texto)) throw new DmNaoEntregavel(usuario);
}

/**
 * Bolhas da conversa aberta, na ordem da tela. A nossa fica à direita do centro, a do contato à esquerda.
 * Depende de layout de verdade, por isso não tem teste com HTML de exemplo.
 */
async function bolhasDaConversa(page: Page): Promise<Array<{ texto: string; nossa: boolean }>> {
  return await page.evaluate(() => {
    const caixa = document.querySelector('[role="textbox"][contenteditable="true"]');
    const topoDaCaixa = caixa ? caixa.getBoundingClientRect().top : window.innerHeight;
    const itens: Array<{ texto: string; nossa: boolean }> = [];
    for (const grupo of Array.from(document.querySelectorAll('[role="group"]')) as HTMLElement[]) {
      if (grupo.querySelector('[role="group"]')) continue;
      const r = grupo.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.bottom > topoDaCaixa) continue;
      const texto = (grupo.innerText || "").replace(/\s+/g, " ").trim();
      if (!texto) continue;
      let bolha: HTMLElement | null = null;
      for (let c: HTMLElement | null = grupo; c && c !== grupo.parentElement?.parentElement; c = c.firstElementChild as HTMLElement | null) {
        const fundo = window.getComputedStyle(c).backgroundColor;
        if (fundo && fundo !== "transparent" && !/rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\)/.test(fundo)) {
          bolha = c;
          break;
        }
      }
      const medida = (bolha ?? grupo).getBoundingClientRect();
      const limites = (bolha ? grupo : (grupo.parentElement ?? document.body)).getBoundingClientRect();
      itens.push({ texto, nossa: medida.left + medida.width / 2 > limites.left + limites.width / 2 });
    }
    return itens;
  });
}

/** O contato respondeu? Verdadeiro quando a última bolha da conversa é dele. */
export async function contatoRespondeu(page: Page, usuario: string): Promise<boolean> {
  await abrirConversa(page, usuario);
  await pausa(RITMO.leitura);
  const bolhas = await bolhasDaConversa(page);
  const ultima = bolhas.at(-1);
  return ultima !== undefined && !ultima.nossa;
}

async function digitar(page: Page, alvo: Locator, texto: string): Promise<void> {
  await alvo.click();
  for (const letra of texto) {
    if (letra === "\n") await page.keyboard.press("Shift+Enter");
    else await page.keyboard.type(letra);
    await pausa(RITMO.letra);
    if (/[\s.,!?;:]/.test(letra)) await pausa(RITMO.palavra);
  }
}

/**
 * Abre o perfil, abre a conversa, digita no ritmo de uma pessoa e envia. `antesDoClique` roda logo
 * antes do único passo sem volta (marca o lead como "enviando" para nunca repetir depois de uma queda).
 */
export async function enviarDM(page: Page, usuario: string, texto: string, antesDoClique: () => Promise<void>): Promise<{ confirmado: boolean }> {
  const caixa = await abrirConversa(page, usuario);
  await checarEntregavel(page, usuario);
  await pausa(RITMO.leitura);
  await digitar(page, caixa, texto);
  await pausa(RITMO.antesDeEnviar);
  await antesDoClique();
  const botao = page.getByRole("button", { name: BOTAO_ENVIAR }).first();
  const clicou = await botao.click({ timeout: 2_000 }).then(() => true, () => botao.click({ force: true, timeout: 2_000 }).then(() => true, () => false));
  if (!clicou) await caixa.press("Enter").catch(() => page.keyboard.press("Enter"));
  // A folha de mensagem prioritária às vezes aparece depois do envio; sem o clique a mensagem não sai.
  await aceitarMensagemPrioritaria(page);
  let confirmado = false;
  const prazo = Date.now() + 8_000;
  while (!confirmado && Date.now() < prazo) {
    await checarSaude(page);
    confirmado = (await caixa.innerText().catch(() => "")).trim().length === 0;
    if (!confirmado) await dormir(250);
  }
  await checarEntregavel(page, usuario);
  return { confirmado };
}
