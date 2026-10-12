// Erros do navegador a que o worker reage de jeitos diferentes.

/** Chrome fechado, porta errada ou aba que morreu: adia o trabalho, não conta como falha. */
export class ChromeIndisponivel extends Error {
  constructor(mensagem = "Chrome dedicado indisponível") {
    super(mensagem);
    this.name = "ChromeIndisponivel";
  }
}

/** Caiu na tela de login: a pessoa precisa entrar de novo no Instagram pela janela do Chrome. */
export class SessaoPerdida extends Error {
  constructor(mensagem = "Sessão do Instagram perdida no Chrome dedicado") {
    super(mensagem);
    this.name = "SessaoPerdida";
  }
}

/** Desafio, "tente mais tarde", ação bloqueada: pausa tudo e deixa a pessoa olhar. */
export class RestricaoDoInstagram extends Error {
  constructor(mensagem = "O Instagram restringiu a ação") {
    super(mensagem);
    this.name = "RestricaoDoInstagram";
  }
}

export class PerfilNaoEncontrado extends Error {
  constructor(usuario: string) {
    super(`Perfil @${usuario} não encontrado`);
    this.name = "PerfilNaoEncontrado";
  }
}

/** Sem botão de mensagem (permanente) ou caixa que não abriu (`retentavel`: o Instagram segura threads novas por um tempo). */
export class DmIndisponivel extends Error {
  readonly retentavel: boolean;
  constructor(mensagem: string, retentavel = false) {
    super(mensagem);
    this.name = "DmIndisponivel";
    this.retentavel = retentavel;
  }
}

/** A conversa abriu, mas o perfil não aceita mensagem de quem ele não segue. */
export class DmNaoEntregavel extends Error {
  constructor(usuario: string) {
    super(`@${usuario} não aceita novas solicitações de mensagem`);
    this.name = "DmNaoEntregavel";
  }
}

/** Aba ou Chrome que morreu no meio do trabalho. É Chrome indisponível, não falha do trabalho. */
export const QUEDA_DO_CHROME = /Target crashed|Page crashed|Target page, context or browser has been closed|Browser has been closed|chrome-error:\/\/chromewebdata|ECONNREFUSED/;

export function chromeCaiu(erro: unknown): boolean {
  return erro instanceof ChromeIndisponivel || (erro instanceof Error && QUEDA_DO_CHROME.test(erro.message));
}
