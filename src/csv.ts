// Planilha de saída. Abre no Excel e no Google Planilhas.

/** Célula de CSV. Texto que começa com = + - @ vira texto puro: bio de estranho não roda fórmula na planilha. */
export function celulaCsv(valor: unknown): string {
  let texto = valor === null || valor === undefined ? "" : String(valor);
  if (/^[=+\-@\t\r]/.test(texto)) texto = `'${texto}`;
  return /[",\n\r;]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

export const COLUNAS = ["usuario", "link", "estado", "lead_quente", "pontuacao", "nome", "seguidores", "posts", "bio", "origem", "motivos", "abertura", "seguimento", "operador", "contatado_em", "respondeu_em", "seguimentos"];

export function linhasCsv(leads: Array<Record<string, unknown>>): string {
  const corpo = leads.map((l) =>
    COLUNAS.map((c) => celulaCsv(c === "link" ? `https://www.instagram.com/${l.usuario}/` : c === "lead_quente" ? (l.respondeu_em ? "sim" : "não") : l[c])).join(","),
  );
  // BOM no começo para o Excel abrir acentos certos.
  return `\uFEFF${[COLUNAS.join(","), ...corpo].join("\r\n")}\r\n`;
}
