// Chrome da própria pessoa, num perfil dedicado, controlado pela porta de depuração (CDP).
// O programa nunca guarda senha: a pessoa entra no Instagram uma vez nessa janela.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { platform } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import type { Config } from "../config.ts";
import { ChromeIndisponivel } from "./erros.ts";

const TIMEOUT_CONEXAO_MS = 10_000;
const TIMEOUT_ACAO_MS = 20_000;
const TIMEOUT_NAVEGACAO_MS = 45_000;
const ARQUIVO_LANCAMENTO = resolve("dados/chrome.json");

function base(config: Config): string {
  return `http://127.0.0.1:${config.chrome.porta}`;
}

export async function chromeNoAr(config: Config): Promise<boolean> {
  try {
    return (await fetch(`${base(config)}/json/version`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

function binariosCandidatos(): string[] {
  const proprio = process.env.CHROME_PATH ? [process.env.CHROME_PATH] : [];
  switch (platform()) {
    case "darwin":
      return [...proprio, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"];
    case "win32":
      return [
        ...proprio,
        `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      ];
    default:
      return [...proprio, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"];
  }
}

/**
 * Abre o Chrome dedicado com a porta de depuração presa em 127.0.0.1 (ela dá controle total da
 * sessão logada; nunca exponha fora da máquina). Grava pid e perfil para poder reiniciar depois.
 */
export async function abrirChrome(config: Config): Promise<"ja_aberto" | "aberto"> {
  if (await chromeNoAr(config)) return "ja_aberto";
  const binario = binariosCandidatos().find((caminho) => existsSync(caminho));
  if (!binario) throw new Error("Não encontrei o Google Chrome. Instale o Chrome ou informe o caminho em CHROME_PATH no .env.");
  const perfil = resolve(config.chrome.perfil);
  mkdirSync(perfil, { recursive: true });
  const filho = spawn(
    binario,
    [`--remote-debugging-port=${config.chrome.porta}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${perfil}`, "--no-first-run", "--no-default-browser-check", "https://www.instagram.com/"],
    { detached: true, stdio: "ignore" },
  );
  filho.unref();
  mkdirSync(resolve("dados"), { recursive: true });
  writeFileSync(ARQUIVO_LANCAMENTO, JSON.stringify({ pid: filho.pid, porta: config.chrome.porta, perfil }));
  const prazo = Date.now() + 20_000;
  while (Date.now() < prazo) {
    if (await chromeNoAr(config)) return "aberto";
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`O Chrome abriu mas a porta ${config.chrome.porta} não respondeu em 20 s. Feche todas as janelas desse perfil e tente de novo.`);
}

/**
 * Chrome sem nenhuma aba continua na porta mas recusa o CDP. Uma aba nova pelo endpoint HTTP
 * resolve, sem precisar do CDP. Acontece quando alguém fecha a janela do Chrome dedicado.
 */
async function garantirAbaAberta(config: Config): Promise<void> {
  const alvos = ((await fetch(`${base(config)}/json/list`, { signal: AbortSignal.timeout(5_000) })
    .then((r) => r.json() as Promise<Array<{ type?: string }>>)
    .catch(() => null)) ?? []) as Array<{ type?: string }>;
  if (alvos.some((a) => a.type === "page")) return;
  await fetch(`${base(config)}/json/new?https://www.instagram.com/`, { method: "PUT", signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 2_000));
}

/**
 * Roda `fn` numa aba nova do Chrome dedicado e fecha a aba no fim. Nunca usa as abas da pessoa e
 * nunca fecha o Chrome: `browser.close()` numa conexão CDP só desconecta. Aba nova a cada trabalho
 * também evita a memória acumulada numa aba só.
 */
export async function comPagina<T>(config: Config, fn: (page: Page) => Promise<T>): Promise<T> {
  await garantirAbaAberta(config);
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(base(config), { timeout: TIMEOUT_CONEXAO_MS });
  } catch (erro) {
    throw new ChromeIndisponivel(`Não consegui conectar ao Chrome dedicado na porta ${config.chrome.porta}. Rode \`npm run chrome\`. (${erro instanceof Error ? erro.message.split("\n")[0] : String(erro)})`);
  }
  let page: Page | undefined;
  try {
    const contexto = browser.contexts()[0];
    if (!contexto) throw new ChromeIndisponivel("O Chrome dedicado não tem janela aberta. Abra uma e entre no Instagram.");
    page = await contexto.newPage();
    page.setDefaultTimeout(TIMEOUT_ACAO_MS);
    page.setDefaultNavigationTimeout(TIMEOUT_NAVEGACAO_MS);
    return await fn(page);
  } catch (erro) {
    // Print da tela para entender seletor que mudou. Fica só na máquina, em dados/diagnostico.
    if (page && !(erro instanceof ChromeIndisponivel)) {
      const pasta = resolve("dados/diagnostico");
      await mkdir(pasta, { recursive: true }).catch(() => undefined);
      await page.screenshot({ path: join(pasta, `${new Date().toISOString().replace(/[:.]/g, "-")}.png`) }).catch(() => undefined);
    }
    throw erro;
  } finally {
    await page?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

/**
 * Reinicia o Chrome dedicado para devolver a memória que ele acumula em horas de uso. Só mexe num
 * Chrome que este programa abriu (`npm run chrome`), para nunca fechar o navegador da pessoa.
 */
export async function reiniciarChrome(config: Config): Promise<boolean> {
  if (!existsSync(ARQUIVO_LANCAMENTO)) return false;
  const lancado = JSON.parse(readFileSync(ARQUIVO_LANCAMENTO, "utf8")) as { pid?: number; porta?: number; perfil?: string };
  if (lancado.porta !== config.chrome.porta || lancado.perfil !== resolve(config.chrome.perfil) || !lancado.pid) return false;
  try {
    process.kill(lancado.pid, 0);
  } catch {
    return false;
  }
  try {
    const browser = await chromium.connectOverCDP(base(config), { timeout: TIMEOUT_CONEXAO_MS });
    // Browser.close fecha com calma e grava os cookies, então a sessão do Instagram continua.
    await (await browser.newBrowserCDPSession()).send("Browser.close").catch(() => undefined);
  } catch {
    return false;
  }
  const prazo = Date.now() + 15_000;
  while (Date.now() < prazo && (await chromeNoAr(config))) await new Promise((r) => setTimeout(r, 500));
  await abrirChrome(config);
  return true;
}
