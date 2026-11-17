import { EmailBrand, RenderedEmail } from '../../domain/email-message';
import { escapeHtml, safeUrl, singleLine } from './escape';

const DEFAULT_COLOR = '#0F5E9C';
const PRODUCT_NAME = 'Dentalix';
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Un párrafo del cuerpo: texto plano (se escapa al pintarlo). */
export interface EmailBlock {
  kind: 'paragraph' | 'note';
  text: string;
}

/** DX-568: una celda de una tabla del email (texto y, si lleva, su enlace). */
export interface EmailTableCell {
  text: string;
  /** Enlace http(s) de la celda; sin él, solo texto. */
  url?: string | null;
}

/** DX-568: una fila: sus celdas y, si lleva, un aviso bajo la primera. */
export interface EmailTableRow {
  cells: EmailTableCell[];
  note?: string | null;
}

/**
 * DX-568: una tabla de cifras (p. ej. una sede del resumen semanal). La
 * primera columna es la etiqueta (a la izquierda); el resto, cifras (a la
 * derecha). En el texto, columnas alineadas con espacios.
 */
export interface EmailTable {
  title: string;
  columns: string[];
  rows: EmailTableRow[];
}

export interface EmailLayoutInput {
  brand: EmailBrand | null;
  subject: string;
  heading: string;
  blocks: EmailBlock[];
  /** Botón principal (enlace http(s)); sin él, el email no lleva botón. */
  action: { label: string; url: string } | null;
  /**
   * Enlace secundario al pie (p. ej. la baja de los recordatorios, DX-128):
   * una frase y el enlace, discretos, debajo de la tarjeta.
   */
  footerLink?: { lead: string; label: string; url: string } | null;
  /**
   * DX-469: enlaces secundarios bajo el botón (p. ej. «Añadir a mi
   * calendario»): una frase y varios enlaces en una línea.
   */
  links?: { lead: string; items: { label: string; url: string }[] } | null;
  /**
   * DX-290: un segundo llamado, bajo el botón y antes de `links` (p. ej. el
   * cuestionario de salud del recordatorio): una frase y su enlace.
   */
  callout?: { lead: string; label: string; url: string } | null;
  /** DX-568: tablas de cifras tras los párrafos y antes del botón. */
  tables?: EmailTable[] | null;
  /** DX-568: párrafos tras las tablas (definiciones y avisos de las cifras). */
  closingBlocks?: EmailBlock[] | null;
  /**
   * DX-497: textos fijos del esqueleto (idioma del HTML, ayuda del botón y
   * pie) en el idioma del email. Ausente = los de la clínica (español).
   */
  chrome?: EmailLayoutChrome;
}

export interface EmailLayoutChrome {
  htmlLang: string;
  buttonFallback: string;
  footerClinic: (clinic: string, product: string) => string;
  footerPlatform: (product: string) => string;
}

const DEFAULT_CHROME: EmailLayoutChrome = {
  htmlLang: 'es',
  buttonFallback: 'Si el botón no funciona, copia este enlace en tu navegador:',
  footerClinic: (clinic, product) =>
    `Enviado por ${clinic} a través de ${product}.`,
  footerPlatform: (product) => `Enviado por ${product}.`,
};

/** La URL de una celda, validada: una que no sea http(s) es un error de quien llama. */
function cellUrl(cell: EmailTableCell): string | null {
  if (!cell.url) return null;
  const url = safeUrl(cell.url);
  if (!url) throw new Error('El enlace del email no es una URL http(s) válida');
  return url;
}

function tableHtml(table: EmailTable, color: string): string {
  const head = table.columns
    .map(
      (column, i) =>
        `<th style="padding:6px 8px;border-bottom:1px solid #e4e7eb;font-size:12px;font-weight:600;color:#5b6472;text-align:${i === 0 ? 'left' : 'right'}">${escapeHtml(column)}</th>`,
    )
    .join('');
  const rows = table.rows
    .map((row) => {
      const cells = row.cells
        .map((cell, i) => {
          const url = cellUrl(cell);
          const text = escapeHtml(cell.text);
          const content = url
            ? `<a href="${escapeHtml(url)}" style="color:${color};text-decoration:none">${text}</a>`
            : text;
          const note =
            i === 0 && row.note
              ? `<br /><span style="font-size:12px;color:#b45309">${escapeHtml(row.note)}</span>`
              : '';
          return `<td style="padding:6px 8px;border-bottom:1px solid #f0f2f4;font-size:14px;line-height:1.4;color:#1f2933;text-align:${i === 0 ? 'left' : 'right'};${i === 0 ? '' : 'white-space:nowrap;'}vertical-align:top">${content}${note}</td>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('\n');
  return `<h2 style="margin:24px 0 8px;font-size:16px;line-height:1.3;color:#1f2933">${escapeHtml(table.title)}</h2>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
<tr>${head}</tr>
${rows}
</table>`;
}

/** Ancho visible de un texto (por puntos de código: tildes y «–» cuentan uno). */
function width(text: string): number {
  return [...text].length;
}

function pad(text: string, size: number, right: boolean): string {
  const fill = ' '.repeat(Math.max(0, size - width(text)));
  return right ? fill + text : text + fill;
}

/** La tabla en texto: columnas alineadas, avisos y enlaces bajo cada fila. */
function tableText(table: EmailTable): string[] {
  const lines = [singleLine(table.title)];
  const grid = [
    table.columns.map((c) => singleLine(c)),
    ...table.rows.map((row) => row.cells.map((c) => singleLine(c.text))),
  ];
  const sizes = table.columns.map((_, i) =>
    Math.max(...grid.map((cells) => width(cells[i] ?? ''))),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => pad(cell, sizes[i], i > 0))
      .join('  ')
      .trimEnd();
  lines.push(line(grid[0]));
  table.rows.forEach((row, r) => {
    lines.push(line(grid[r + 1]));
    if (row.note) lines.push(`  ${singleLine(row.note)}`);
    const url = row.cells.map(cellUrl).find((u) => u !== null);
    if (url) lines.push(`  ${url}`);
  });
  return lines;
}

/**
 * Esqueleto común de los emails: cabecera con la marca de la clínica (logo si
 * tiene uno usable, si no su nombre), título, párrafos, botón y pie. HTML
 * sencillo con estilos en línea (lo único que respetan los clientes de
 * correo) y versión de texto equivalente. Todo lo variable se escapa aquí.
 */
export function renderLayout(input: EmailLayoutInput): RenderedEmail {
  const senderName = singleLine(input.brand?.clinicName ?? PRODUCT_NAME);
  const chrome = input.chrome ?? DEFAULT_CHROME;
  const color =
    input.brand?.primaryColor && HEX_COLOR.test(input.brand.primaryColor)
      ? input.brand.primaryColor
      : DEFAULT_COLOR;
  const logoUrl = safeUrl(input.brand?.logoUrl);
  const actionUrl = input.action ? safeUrl(input.action.url) : null;
  if (input.action && !actionUrl) {
    throw new Error('El enlace del email no es una URL http(s) válida');
  }
  const footerUrl = input.footerLink ? safeUrl(input.footerLink.url) : null;
  if (input.footerLink && !footerUrl) {
    throw new Error('El enlace del email no es una URL http(s) válida');
  }

  const header = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(senderName)}" style="max-height:48px;max-width:200px;border:0" />`
    : `<span style="font-size:20px;font-weight:600;color:${color}">${escapeHtml(senderName)}</span>`;

  const blockHtml = (block: EmailBlock) =>
    block.kind === 'note'
      ? `<p style="margin:16px 0 0;font-size:13px;line-height:1.5;color:#5b6472">${escapeHtml(block.text)}</p>`
      : `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#1f2933">${escapeHtml(block.text)}</p>`;
  const body = input.blocks.map(blockHtml).join('\n');
  const closing = input.closingBlocks ?? [];

  const button =
    input.action && actionUrl
      ? `<p style="margin:24px 0"><a href="${escapeHtml(actionUrl)}" style="display:inline-block;background:${color};color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px">${escapeHtml(input.action.label)}</a></p>
<p style="margin:0 0 12px;font-size:13px;line-height:1.5;color:#5b6472">${escapeHtml(chrome.buttonFallback)}<br /><span style="word-break:break-all">${escapeHtml(actionUrl)}</span></p>`
      : '';

  const links = (input.links?.items ?? []).map((item) => {
    const url = safeUrl(item.url);
    if (!url)
      throw new Error('El enlace del email no es una URL http(s) válida');
    return { label: item.label, url };
  });
  const linksHtml =
    input.links && links.length > 0
      ? `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#1f2933">${escapeHtml(input.links.lead)} ${links
          .map(
            (l) =>
              `<a href="${escapeHtml(l.url)}" style="color:${color};font-weight:600">${escapeHtml(l.label)}</a>`,
          )
          .join(' · ')}</p>`
      : '';

  const calloutUrl = input.callout ? safeUrl(input.callout.url) : null;
  if (input.callout && !calloutUrl) {
    throw new Error('El enlace del email no es una URL http(s) válida');
  }
  const calloutHtml =
    input.callout && calloutUrl
      ? `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#1f2933">${escapeHtml(input.callout.lead)}<br /><a href="${escapeHtml(calloutUrl)}" style="color:${color};font-weight:600">${escapeHtml(input.callout.label)}</a></p>`
      : '';

  const tables = input.tables ?? [];
  // Sin tablas, el HTML queda byte a byte como antes de DX-568.
  const tablesHtml = [
    ...tables.map((t) => tableHtml(t, color)),
    ...closing.map(blockHtml),
  ]
    .map((html) => `${html}\n`)
    .join('');

  const footerText = input.brand
    ? chrome.footerClinic(senderName, PRODUCT_NAME)
    : chrome.footerPlatform(PRODUCT_NAME);
  const footer = escapeHtml(footerText);
  const footerLink =
    input.footerLink && footerUrl
      ? `<p style="margin:8px 0 0;font-size:12px;color:#7b8794">${escapeHtml(input.footerLink.lead)} <a href="${escapeHtml(footerUrl)}" style="color:#5b6472">${escapeHtml(input.footerLink.label)}</a></p>`
      : '';

  const html = `<!doctype html>
<html lang="${escapeHtml(chrome.htmlLang)}">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${escapeHtml(singleLine(input.subject))}</title></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;padding:28px">
<tr><td style="padding-bottom:20px;border-bottom:1px solid #e4e7eb">${header}</td></tr>
<tr><td style="padding-top:20px">
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#1f2933">${escapeHtml(input.heading)}</h1>
${body}
${tablesHtml}${button}
${calloutHtml}
${linksHtml}
</td></tr>
</table>
<p style="margin:16px 0 0;font-size:12px;color:#7b8794">${footer}</p>
${footerLink}
</td></tr>
</table>
</body>
</html>`;

  const textParts = [
    senderName,
    '',
    singleLine(input.heading),
    '',
    ...input.blocks.map((block) => singleLine(block.text)),
  ];
  for (const table of tables) textParts.push('', ...tableText(table));
  if (closing.length > 0) {
    textParts.push('', ...closing.map((block) => singleLine(block.text)));
  }
  if (input.action && actionUrl) {
    textParts.push('', `${singleLine(input.action.label)}: ${actionUrl}`);
  }
  if (input.callout && calloutUrl) {
    textParts.push(
      '',
      singleLine(input.callout.lead),
      `${singleLine(input.callout.label)}: ${calloutUrl}`,
    );
  }
  if (input.links && links.length > 0) {
    textParts.push('', singleLine(input.links.lead));
    for (const l of links) textParts.push(`${singleLine(l.label)}: ${l.url}`);
  }
  textParts.push('', '—', footerText);
  if (input.footerLink && footerUrl) {
    textParts.push(
      `${singleLine(input.footerLink.lead)} ${singleLine(input.footerLink.label)}: ${footerUrl}`,
    );
  }

  return {
    subject: singleLine(input.subject),
    html,
    text: textParts.join('\n'),
  };
}
