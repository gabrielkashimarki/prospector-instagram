// Comandos: instalar, chrome, descobrir, rodar, status, pausar, retomar, exportar, respostas, aprovar.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseDocument } from "yaml";
import { carregarConfig, type Config, type Segredos, validarConfig } from "./config.ts";
import { abrirBanco, type Banco, criarLead, lerEstado, registrarOperador } from "./db.ts";
import { contarJobs, enfileirar } from "./fila.ts";
import { gastoDeHoje } from "./ia.ts";
import { abrirChrome, chromeNoAr } from "./navegador/chrome.ts";
import { usuarioValido } from "./navegador/extrair.ts";
import { acoesDeHoje, dentroDaJanela, partesLocais, proximaAbertura, tetoDeDmHoje } from "./ritmo.ts";
import { lerPausa, pausar, retomar, rodar } from "./worker.ts";
import { linhasCsv } from "./csv.ts";

async function abrir(): Promise<{ config: Config; segredos: Segredos; db: Banco }> {
  const { config, segredos } = carregarConfig();
  const db = await abrirBanco(segredos.databaseUrl, config.banco.arquivo);
  return { config, segredos, db };
}

// ---------------------------------------------------------------- instalar

const MODELOS = {
  anthropic: { modelo: "claude-haiku-5-5", entrada: 0.1, saida: 0.5, onde: "console.anthropic.com > API Keys" },
  openai: { modelo: "gpt-5-mini", entrada: 0.25, saida: 2.0, onde: "platform.openai.com > API keys" },
  openrouter: { modelo: "openai/gpt-5-mini", entrada: 0.25, saida: 2.0, onde: "openrouter.ai > Keys" },
} as const;

async function instalar(): Promise<void> {
  const [maior, menor] = process.versions.node.split(".").map(Number);
  if (maior! < 22 || (maior === 22 && menor! < 18)) throw new Error(`Precisa do Node 22.18 ou mais novo (você tem ${process.versions.node}). Baixe a versão LTS em nodejs.org.`);

  let mudo = false;
  const saida = new Writable({
    write(parte, _codificacao, pronto) {
      if (!mudo) process.stdout.write(parte);
      pronto();
    },
  });
  // Lê linha a linha pelo iterador: funciona digitando e também com respostas coladas de uma vez.
  const rl = createInterface({ input: process.stdin, output: saida, terminal: Boolean(process.stdin.isTTY) });
  const linhas = rl[Symbol.asyncIterator]();
  const lerLinha = async (): Promise<string> => {
    const proxima = await linhas.next();
    if (proxima.done) throw new Error("Entrada encerrada antes do fim do assistente.");
    return String(proxima.value).trim();
  };
  const perguntar = async (texto: string, padrao = ""): Promise<string> => {
    process.stdout.write(`${texto}${padrao ? ` [${padrao}]` : ""}: `);
    return (await lerLinha()) || padrao;
  };
  const segredo = async (texto: string): Promise<string> => {
    process.stdout.write(`${texto} (não aparece na tela): `);
    mudo = true;
    try {
      return await lerLinha();
    } finally {
      mudo = false;
      process.stdout.write("\n");
    }
  };
  const lista = (texto: string) => texto.split(",").map((t) => t.trim().replace(/^[@#]/, "")).filter(Boolean);

  try {
    console.log("\nAssistente de instalação do prospector. Enter aceita o valor entre colchetes.\n");
    if (existsSync("config.yaml") && (await perguntar("Já existe um config.yaml. Refazer do zero? (s/N)", "n")).toLowerCase() !== "s") {
      console.log("Mantive o config.yaml. Edite o arquivo direto para ajustar.");
      return;
    }
    const doc = parseDocument(readFileSync("config.example.yaml", "utf8"));
    const definir = (caminho: string[], valor: unknown) => doc.setIn(caminho, valor);

    console.log("1/5  Você");
    const nome = await perguntar("Seu nome (assina as mensagens)");
    const instagram = (await perguntar("O @ do Instagram que vai prospectar, nesta máquina")).replace(/^@/, "").toLowerCase();
    if (!nome || !usuarioValido(instagram)) throw new Error("Nome e @ do Instagram são obrigatórios (o @ só aceita letras, números, ponto e sublinhado).");
    definir(["operador", "nome"], nome);
    definir(["operador", "instagram"], instagram);
    definir(["mensagem", "remetente"], nome);

    console.log("\n2/5  Quem você procura");
    definir(["nicho"], await perguntar('Nicho em poucas palavras (ex.: "clínicas de estética")'));
    const buscas = lista(await perguntar("Termos de busca, separados por vírgula"));
    const hashtags = lista(await perguntar("Hashtags, separadas por vírgula (sem #)"));
    if (buscas.length + hashtags.length === 0) throw new Error("Informe pelo menos um termo de busca ou uma hashtag.");
    definir(["descoberta", "buscas"], buscas);
    definir(["descoberta", "hashtags"], hashtags);
    definir(["qualificacao", "palavras_chave"], lista(await perguntar("Palavras que indicam o perfil certo, separadas por vírgula")));
    definir(["qualificacao", "palavras_negativas"], lista(await perguntar("Palavras que eliminam o perfil, separadas por vírgula", "vagas")));
    definir(["qualificacao", "cliente_ideal"], await perguntar("Descreva o cliente ideal em uma frase"));

    console.log("\n3/5  A mensagem");
    definir(["mensagem", "empresa"], await perguntar("Nome da sua empresa (Enter para nenhum)"));
    definir(["mensagem", "oferta"], await perguntar("O que você oferece, em uma frase"));
    definir(["mensagem", "tom"], await perguntar("Tom da mensagem", "informal, direto, simpático, sem exagero de emoji"));

    console.log("\n4/5  Inteligência artificial (só escreve rascunhos e dá nota; a instalação não usa IA)");
    const opcaoIa = await perguntar("1 Anthropic Claude Haiku (mais barato)  2 OpenAI  3 OpenRouter", "1");
    const provedor = ({ "2": "openai", "3": "openrouter" } as Record<string, "openai" | "openrouter" | undefined>)[opcaoIa] ?? "anthropic";
    const m = MODELOS[provedor];
    definir(["ia", "provedor"], provedor);
    definir(["ia", "modelo"], m.modelo);
    definir(["ia", "preco_entrada_por_milhao"], m.entrada);
    definir(["ia", "preco_saida_por_milhao"], m.saida);
    const iaChave = await segredo(`Chave da API (pegue em ${m.onde})`);

    console.log("\n5/5  Onde guardar os dados");
    const varios = (await perguntar("1 Um computador (SQLite, nada a configurar)  2 Vários computadores (Supabase)", "1")) === "2";
    const databaseUrl = varios ? await segredo("Connection string do Supabase (pooler, porta 6543; veja o README)") : "";
    const opcaoCaixa = await perguntar("Respostas: 1 Responder pelo celular  2 Zernio  3 App próprio da Meta", "1");
    const caixa = ({ "2": "zernio", "3": "meta" } as Record<string, "zernio" | "meta" | undefined>)[opcaoCaixa] ?? "nenhum";
    definir(["caixa", "provedor"], caixa);
    const zernioChave = caixa === "zernio" ? await segredo("Chave da API da Zernio") : "";
    if (caixa === "zernio") definir(["caixa", "zernio_conta"], await perguntar("Id da conta do Instagram na Zernio"));
    const metaToken = caixa === "meta" ? await segredo("Token da conta do Instagram gerado no painel do app da Meta") : "";
    if (varios && caixa !== "nenhum" && (await perguntar("Receber respostas na hora pela Edge Function do Supabase? (s/N)", "n")).toLowerCase() === "s") definir(["caixa", "receber"], "webhook_supabase");

    validarConfig(doc.toJS());
    writeFileSync("config.yaml", doc.toString());
    const env = [`IA_CHAVE=${iaChave}`, `DATABASE_URL=${databaseUrl}`, `ZERNIO_API_KEY=${zernioChave}`, `META_ACCESS_TOKEN=${metaToken}`, "CHROME_PATH=", ""].join("\n");
    writeFileSync(".env", env, { mode: 0o600 });
    chmodSync(".env", 0o600);
    mkdirSync("dados", { recursive: true });

    const { config, db } = await abrir();
    await registrarOperador(db, config.operador.nome, config.operador.instagram);
    await db.fechar();
    console.log(`
Pronto. config.yaml e .env criados; banco ${varios ? "compartilhado (Supabase)" : "local (SQLite)"} preparado.
O modo começa em RASCUNHO: nada é enviado até você trocar "modo" para "envio" no config.yaml.

Próximos passos:
  npm run chrome      abre o Chrome dedicado; entre no Instagram com @${instagram}
  npm run descobrir   coloca as buscas e hashtags na fila
  npm run rodar       trabalha a fila (deixe aberto; Ctrl+C para parar)
  npm run status      mostra o andamento e o gasto de IA do dia
  npm run exportar    gera a planilha com os leads e os rascunhos
`);
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------- descobrir

async function descobrir(): Promise<void> {
  const { config, db } = await abrir();
  const dia = partesLocais(new Date(), config.janela.fuso).dia;
  let fila = 0;
  // A chave inclui o dia: rodar duas vezes no mesmo dia (ou em duas máquinas) não duplica a busca.
  for (const valor of config.descoberta.buscas) if (await enfileirar(db, "descobrir", { fonte: "busca", valor }, { chave: `descobrir:busca:${valor}:${dia}`, prioridade: 10 })) fila += 1;
  for (const valor of config.descoberta.hashtags) if (await enfileirar(db, "descobrir", { fonte: "hashtag", valor }, { chave: `descobrir:hashtag:${valor}:${dia}`, prioridade: 10 })) fila += 1;
  let perfis = 0;
  for (const bruto of config.descoberta.perfis) {
    const usuario = bruto.trim().replace(/^@/, "").toLowerCase();
    if (!usuarioValido(usuario)) continue;
    const lead = await criarLead(db, usuario, "perfil_semente");
    if (lead.novo && (await enfileirar(db, "ler_perfil", { leadId: lead.id }, { chave: `ler_perfil:${lead.id}`, prioridade: 20 }))) perfis += 1;
  }
  console.log(`${fila} busca(s) e ${perfis} perfil(is) novos na fila. Rode \`npm run rodar\` para começar.`);
  await db.fechar();
}

// ---------------------------------------------------------------- status

async function status(): Promise<void> {
  const { config, segredos, db } = await abrir();
  const eu = config.operador.instagram;
  const agora = new Date();
  const linha = (rotulo: string, valor: string) => console.log(`${rotulo.padEnd(18)} ${valor}`);
  console.log("");
  linha("Operador", `@${eu} (${config.operador.nome})`);
  linha("Modo", config.modo === "envio" ? "ENVIO: DMs saem de verdade" : "rascunho: nenhuma DM sai");
  linha("Banco", segredos.databaseUrl ? `compartilhado em ${new URL(segredos.databaseUrl).hostname}` : `local em ${config.banco.arquivo}`);
  const pausa = await lerPausa(db, eu);
  linha("Pausa", pausa ? `PAUSADO desde ${new Date(pausa.desde).toLocaleString("pt-BR")}: ${pausa.motivo}` : "não");
  linha("Janela", dentroDaJanela(agora, config.janela) ? "aberta agora" : `fechada, abre ${proximaAbertura(agora, config.janela).toLocaleString("pt-BR", { timeZone: config.janela.fuso })}`);
  linha("Chrome dedicado", (await chromeNoAr(config)) ? `no ar na porta ${config.chrome.porta}` : "fechado (rode `npm run chrome`)");

  const feitas = await acoesDeHoje(db, config, eu, agora);
  const tetoDm = tetoDeDmHoje(config.limites, await lerEstado<string>(db, `aquecimento_inicio:${eu}`), agora);
  linha("Hoje (esta conta)", `DMs ${feitas.dm ?? 0}/${tetoDm}  curtidas ${feitas.curtida ?? 0}/${config.limites.curtida.por_dia}  leituras ${feitas.leitura ?? 0}/${config.limites.leitura.por_dia}  buscas ${feitas.busca ?? 0}/${config.limites.busca.por_dia}`);
  const gasto = await gastoDeHoje(db, config, eu, agora);
  linha("IA hoje", `US$ ${gasto.usd.toFixed(4)} de US$ ${config.ia.teto_diario_usd.toFixed(2)}  (${gasto.chamadas} chamadas, ${gasto.entrada} tokens de entrada, ${gasto.saida} de saída)`);

  const estados = await db.todos<{ estado: string; n: unknown }>("select estado, cast(count(*) as integer) as n from leads group by estado order by estado");
  linha("Leads", estados.map((e) => `${e.estado} ${Number(e.n)}`).join("  ") || "nenhum ainda");
  const jobs = await contarJobs(db);
  linha("Fila", jobs.map((j) => `${j.lane}/${j.status} ${j.total}`).join("  ") || "vazia");
  const rascunhos = await db.todos("select id from mensagens where status = 'rascunho' and operador = ?", [eu]);
  if (rascunhos.length > 0) linha("Respostas", `${rascunhos.length} rascunho(s) esperando você (npm run respostas)`);

  const eventos = await db.todos<{ tipo: string; mensagem: string; criado_em: string }>("select tipo, mensagem, criado_em from eventos where operador = ? or operador is null order by id desc limit 8", [eu]);
  if (eventos.length > 0) {
    console.log("\nÚltimos eventos:");
    for (const e of eventos) console.log(`  ${new Date(e.criado_em).toLocaleString("pt-BR")}  ${e.tipo}: ${e.mensagem}`);
  }
  console.log("");
  await db.fechar();
}

// ---------------------------------------------------------------- exportar

async function exportar(destino?: string): Promise<void> {
  const { db } = await abrir();
  const leads = await db.todos("select * from leads order by pontuacao desc, id");
  mkdirSync("exportacoes", { recursive: true });
  const arquivo = resolve(destino ?? `exportacoes/leads-${new Date().toISOString().slice(0, 10)}.csv`);
  writeFileSync(arquivo, linhasCsv(leads));
  console.log(`${leads.length} lead(s) em ${arquivo}`);
  await db.fechar();
}

// ---------------------------------------------------------------- respostas

async function respostas(): Promise<void> {
  const { config, db } = await abrir();
  const linhas = await db.todos<{ id: number; usuario: string; texto: string; ultima: string | null }>(
    `select m.id, l.usuario, m.texto,
       (select e.texto from mensagens e where e.lead_id = m.lead_id and e.direcao = 'entrada' order by e.criado_em desc limit 1) as ultima
     from mensagens m join leads l on l.id = m.lead_id
     where m.status = 'rascunho' and m.operador = ? order by m.id`,
    [config.operador.instagram],
  );
  if (linhas.length === 0) console.log("Nenhuma resposta em rascunho.");
  for (const r of linhas) console.log(`\n#${r.id}  @${r.usuario}\n  ele(a): ${r.ultima ?? "-"}\n  rascunho: ${r.texto}`);
  if (linhas.length > 0) console.log("\nPara enviar: npm run aprovar -- <número> (ou --todas). Para descartar: npm run aprovar -- --descartar <número>");
  await db.fechar();
}

async function aprovar(args: string[]): Promise<void> {
  const { config, db } = await abrir();
  const eu = config.operador.instagram;
  const descartar = args.includes("--descartar");
  const ids = args.includes("--todas")
    ? (await db.todos<{ id: number }>("select id from mensagens where status = 'rascunho' and operador = ?", [eu])).map((r) => Number(r.id))
    : args.filter((a) => /^\d+$/.test(a)).map(Number);
  if (ids.length === 0) console.log("Diga quais: npm run aprovar -- 12 15, ou --todas.");
  for (const id of ids) {
    const novo = descartar ? "descartada" : "aprovada";
    const ok = await db.todos("update mensagens set status = ?, atualizado_em = ? where id = ? and status = 'rascunho' and operador = ? returning id", [novo, new Date().toISOString(), id, eu]);
    if (ok.length === 0) {
      console.log(`#${id}: não é um rascunho seu.`);
      continue;
    }
    if (!descartar) await enfileirar(db, "enviar_resposta", { mensagemId: id }, { chave: `enviar_resposta:${id}`, operador: eu });
    console.log(`#${id}: ${novo}.`);
  }
  if (!descartar && ids.length > 0) console.log("Sai no próximo ciclo do `npm run rodar` (precisa estar rodando).");
  await db.fechar();
}

// ---------------------------------------------------------------- principal

const AJUDA = `Uso: npm run <comando>
  instalar    assistente de configuração (sem IA)
  chrome      abre o Chrome dedicado para entrar no Instagram
  descobrir   coloca buscas, hashtags e perfis do config.yaml na fila
  rodar       trabalha a fila até você apertar Ctrl+C
  status      andamento, limites do dia e gasto de IA
  pausar      pausa esta conta (npm run pausar -- "motivo")
  retomar     tira a pausa
  exportar    planilha CSV com leads e rascunhos
  respostas   respostas escritas pela IA esperando aprovação
  aprovar     aprova (envia) ou descarta respostas`;

async function principal(): Promise<void> {
  const [comando, ...args] = process.argv.slice(2);
  switch (comando) {
    case "instalar":
      return await instalar();
    case "chrome": {
      const { config } = carregarConfig();
      const r = await abrirChrome(config);
      console.log(
        r === "ja_aberto"
          ? `O Chrome dedicado já está aberto na porta ${config.chrome.porta}.`
          : `Chrome dedicado aberto. Entre no Instagram com @${config.operador.instagram} UMA vez nessa janela; depois disso, deixe a janela aberta e use seu Chrome normal para o resto.`,
      );
      return;
    }
    case "descobrir":
      return await descobrir();
    case "rodar": {
      const { config, segredos, db } = await abrir();
      await rodar(db, config, segredos);
      await db.fechar();
      return;
    }
    case "status":
      return await status();
    case "pausar": {
      const { config, db } = await abrir();
      await pausar(db, config.operador.instagram, args.join(" ") || "pausado pela pessoa");
      console.log("Pausado. `npm run retomar` volta.");
      return await db.fechar();
    }
    case "retomar": {
      const { config, db } = await abrir();
      await retomar(db, config.operador.instagram);
      console.log("Retomado.");
      return await db.fechar();
    }
    case "exportar":
      return await exportar(args[0]);
    case "respostas":
      return await respostas();
    case "aprovar":
      return await aprovar(args);
    default:
      console.log(AJUDA);
  }
}

principal().catch((erro: unknown) => {
  console.error(`\nErro: ${erro instanceof Error ? erro.message : String(erro)}`);
  process.exit(1);
});
