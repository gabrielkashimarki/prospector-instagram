import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import {
  contasDaBusca,
  diagnosticar,
  instantaneo,
  interpretarPerfil,
  lerDescricaoPerfil,
  lerNumero,
  lerPost,
  linkExterno,
  postsDosLinks,
  usuariosDosLinks,
} from "../src/navegador/extrair.ts";

function pagina(arquivo: string, caminho: string): Document {
  const janela = new Window({ url: `https://www.instagram.com${caminho}` });
  janela.document.write(readFileSync(new URL(`./fixtures/${arquivo}`, import.meta.url), "utf8"));
  return janela.document as unknown as Document;
}

describe("lerNumero", () => {
  it.each([
    ["1,234", 1234],
    ["1.234", 1234],
    ["12,5 mil", 12500],
    ["12.5K", 12500],
    ["1,2 mi", 1_200_000],
    ["3M", 3_000_000],
    ["845", 845],
    ["abc", null],
    ["", null],
  ])("%s vira %s", (bruto, esperado) => expect(lerNumero(bruto)).toBe(esperado));
});

describe("perfil", () => {
  const snap = instantaneo(pagina("perfil.html", "/loja.exemplo/"));
  const perfil = interpretarPerfil(snap, "loja.exemplo");

  it("lê contadores e nome do og:description", () => {
    expect(perfil).toMatchObject({ nome: "Loja Exemplo Moda", seguidores: 12500, seguindo: 310, posts: 845 });
  });

  it("lê a bio sem nome, usuário, contadores e botões", () => {
    expect(perfil.bio).toBe("Moda feminina para o dia a dia\nCEO: @fulana.exemplo\nAtendimento (11) 90000-0000 #modafeminina\nloja-exemplo.test");
    expect(perfil.hashtags).toEqual(["#modafeminina"]);
  });

  it("desembrulha o link da bio e vê o botão de contato", () => {
    expect(perfil.linkExterno).toBe("https://loja-exemplo.test/");
    expect(perfil.comercial).toBe(true);
  });

  it("acha os posts do grid, inclusive no formato /usuario/p/", () => {
    expect(postsDosLinks(snap.linksMain)).toEqual(["/loja.exemplo/p/AAA111/", "/p/BBB222/", "/reel/CCC333/"]);
  });

  it("descrição em inglês também funciona", () => {
    expect(lerDescricaoPerfil("1,234 Followers, 56 Following, 78 Posts - See Instagram photos and videos from Some Name (@some.name)")).toEqual({ seguidores: 1234, seguindo: 56, posts: 78, nome: "Some Name" });
  });
});

describe("hashtag e busca", () => {
  const snap = instantaneo(pagina("hashtag.html", "/explore/tags/modafeminina/"));
  const todos = [...snap.linksMain];

  it("pega perfis em minúsculo, sem repetir, sem caminho reservado e sem domínio de fora", () => {
    expect(usuariosDosLinks(todos)).toEqual(["perfil.um", "perfil_dois"]);
  });

  it("pega posts e reels", () => {
    expect(postsDosLinks(todos)).toEqual(["/p/POST01/", "/p/POST02/", "/reel/REEL03/"]);
  });

  it("lê a resposta da busca de contas, descartando reservados e itens sem usuário", () => {
    const json: unknown = JSON.parse(readFileSync(new URL("./fixtures/busca-contas.json", import.meta.url), "utf8"));
    expect(contasDaBusca(json, 10)).toEqual([
      { usuario: "clinica.exemplo", nome: "Clínica Exemplo", privada: false },
      { usuario: "conta_privada", nome: null, privada: true },
      { usuario: "terceira.conta", nome: "Terceira", privada: false },
    ]);
    expect(contasDaBusca(json, 1)).toHaveLength(1);
    expect(contasDaBusca({ formato: "novo" }, 10)).toBeNull();
  });
});

describe("post", () => {
  it("lê legenda, hashtags e autor", () => {
    const snap = instantaneo(pagina("post.html", "/p/POST01/"));
    expect(lerPost(snap.ogTitulo, snap.ogDescricao, snap.linksMain)).toEqual({ legenda: "Coleção nova chegando! #modafeminina #Look", hashtags: ["#modafeminina", "#look"], autor: "perfil.um" });
  });

  it("sem link de autor, usa a descrição", () => {
    expect(lerPost(null, '3 curtidas - outra.conta em 2 de março: "oi"', []).autor).toBe("outra.conta");
  });
});

describe("saúde da página", () => {
  it("tela de login é sessão perdida", () => {
    expect(diagnosticar("/accounts/login/", false, "")).toBe("sessao_perdida");
    expect(diagnosticar("/", true, "")).toBe("sessao_perdida");
  });

  it("desafio e aviso de bloqueio são restrição", () => {
    expect(diagnosticar("/challenge/123/", false, "")).toEqual({ restricao: "O Instagram pediu verificação em /challenge/123/" });
    const snap = instantaneo(pagina("dialogo-bloqueio.html", "/p/POST01/"));
    expect(diagnosticar(snap.caminho, snap.temCampoSenha, snap.textoDialogos)).toEqual({ restricao: "Tente novamente mais tarde" });
  });

  it("página normal está ok", () => {
    const snap = instantaneo(pagina("perfil.html", "/loja.exemplo/"));
    expect(diagnosticar(snap.caminho, snap.temCampoSenha, snap.textoDialogos)).toBe("ok");
  });

  it("link externo ignora links do próprio Instagram", () => {
    expect(linkExterno(["/p/X/", "https://www.instagram.com/outra/"])).toBeNull();
  });
});
