import { EmailBrand, RenderedEmail } from '../../domain/email-message';
import { escapeHtml, safeUrl, singleLine } from './escape';

const DEFAULT_COLOR = '#0F5E9C';
const PRODUCT_NAME = 'Dentalix';
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

// Paleta neutra de DESIGN.md (dentalix-web): el único color de marca es el de
// la clínica; todo lo demás, neutros fijos para que cualquier marca encaje.
const CANVAS = '#F1F5F8';
const SUNKEN = '#F7F9FC';
const BORDER = '#D8DFE6';
const BORDER_SUBTLE = '#E5E9EE';
const INK = '#151C26';
const BODY = '#2B3440';
const MUTED = '#5B6472';
const FAINT = '#6D7582';
/** Fuentes del sistema: los clientes de correo no cargan Inter. */
const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

/** Un párrafo del cuerpo: texto plano (se escapa al pintarlo). */
export interface EmailBlock {
  kind: 'paragraph' | 'note';
  text: string;
  /**
   * DX-564: el texto conserva sus saltos de línea (texto libre de la clínica,
   * p. ej. las indicaciones previas): en HTML, cada línea escapada y `<br />`
   * entre ellas; en el texto plano, una línea por línea. Sin la opción, el
   * bloque es una sola línea, como siempre.
   */
  multiline?: boolean;
  /** DX-564: rótulo en su propia línea antes del texto («Antes de tu cita:»). */
  lead?: string | null;
}

/** DX-564: el texto de un bloque, línea a línea (una si no es multilínea). */
function textLines(block: EmailBlock): string[] {
  return block.multiline
    ? block.text.split(/\r\n|\r|\n/).map((line) => singleLine(line))
    : [singleLine(block.text)];
}

/** Versión de texto de un bloque: el rótulo, si lo lleva, y sus líneas. */
function blockLines(block: EmailBlock): string[] {
  const lines = textLines(block);
  return block.lead ? [singleLine(block.lead), ...lines] : lines;
}

/** El contenido HTML de un bloque (sin las opciones de DX-564, igual que antes). */
function blockContent(block: EmailBlock): string {
  if (!block.multiline && !block.lead) return escapeHtml(block.text);
  const lines = block.multiline
    ? textLines(block).map(escapeHtml)
    : [escapeHtml(block.text)];
  const lead = block.lead
    ? [`<strong>${escapeHtml(singleLine(block.lead))}</strong>`]
    : [];
  return [...lead, ...lines].join('<br />');
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

function tableHtml(table: EmailTable, linkColor: string): string {
  const head = table.columns
    .map(
      (column, i) =>
        `<th style="padding:8px 10px;background:${SUNKEN};border-bottom:1px solid ${BORDER};font-size:12px;font-weight:600;letter-spacing:0.02em;color:${MUTED};text-align:${i === 0 ? 'left' : 'right'}">${escapeHtml(column)}</th>`,
    )
    .join('');
  const rows = table.rows
    .map((row) => {
      const cells = row.cells
        .map((cell, i) => {
          const url = cellUrl(cell);
          const text = escapeHtml(cell.text);
          const content = url
            ? `<a href="${escapeHtml(url)}" style="color:${linkColor};font-weight:600;text-decoration:none">${text}</a>`
            : text;
          const note =
            i === 0 && row.note
              ? `<br /><span style="font-size:12px;color:#834B14">${escapeHtml(row.note)}</span>`
              : '';
          return `<td style="padding:9px 10px;border-bottom:1px solid ${BORDER_SUBTLE};font-size:14px;line-height:1.45;color:${INK};text-align:${i === 0 ? 'left' : 'right'};${i === 0 ? '' : 'white-space:nowrap;font-variant-numeric:tabular-nums;'}vertical-align:top">${content}${note}</td>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('\n');
  return `<h2 style="margin:28px 0 10px;font-size:16px;line-height:1.3;font-weight:600;color:${INK}">${escapeHtml(table.title)}</h2>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border:1px solid ${BORDER};border-radius:10px;overflow:hidden">
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

/** Luminancia relativa (WCAG 2.x) de un `#RRGGBB` ya validado. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Contraste WCAG entre dos colores `#RRGGBB`. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Colores legibles a partir del de la clínica: el texto sobre el botón (blanco
 * o tinta, el que más contraste dé) y el de los enlaces sobre blanco (el de la
 * clínica si llega a 4,5:1; si es muy claro, tinta).
 */
function brandPalette(color: string): { onColor: string; link: string } {
  const onColor =
    contrast(color, '#FFFFFF') >= contrast(color, INK) ? '#FFFFFF' : INK;
  const link = contrast(color, '#FFFFFF') >= 4.5 ? color : INK;
  return { onColor, link };
}

/** La inicial del remitente para el monograma (sin logo). */
function initial(name: string): string {
  const first = [...name.trim()][0] ?? 'D';
  return first.toLocaleUpperCase('es');
}

/** Texto de vista previa (la línea gris de la bandeja), recortado. */
const PREHEADER_MAX = 140;
function preheaderText(blocks: EmailBlock[]): string {
  const first = blocks[0] ? blockLines(blocks[0]).join(' ') : '';
  const chars = [...first];
  return chars.length > PREHEADER_MAX
    ? `${chars
        .slice(0, PREHEADER_MAX - 1)
        .join('')
        .trimEnd()}…`
    : first;
}

/**
 * Esqueleto común de los emails: franja con el color de la clínica, cabecera
 * con su marca (logo si tiene uno usable; si no, monograma y nombre), título,
 * párrafos, botón «a prueba de balas» (tabla, funciona en Outlook) y pie.
 * Estilos en línea (lo único que respetan los clientes de correo), solo modo
 * claro (sin inversión automática que rompa el color de la marca) y versión
 * de texto equivalente. Todo lo variable se escapa aquí.
 */
export function renderLayout(input: EmailLayoutInput): RenderedEmail {
  const senderName = singleLine(input.brand?.clinicName ?? PRODUCT_NAME);
  const chrome = input.chrome ?? DEFAULT_CHROME;
  const color =
    input.brand?.primaryColor && HEX_COLOR.test(input.brand.primaryColor)
      ? input.brand.primaryColor
      : DEFAULT_COLOR;
  const { onColor, link: linkColor } = brandPalette(color);
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
    ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(senderName)}" height="44" style="display:block;max-height:44px;max-width:200px;height:auto;border:0;outline:none" />`
    : `<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td width="40" height="40" align="center" valign="middle" bgcolor="${color}" style="width:40px;height:40px;background:${color};border-radius:10px;font-size:18px;font-weight:700;line-height:40px;color:${onColor};text-align:center">${escapeHtml(initial(senderName))}</td>
<td style="padding-left:12px;vertical-align:middle"><span style="font-size:17px;font-weight:600;line-height:1.3;color:${INK}">${escapeHtml(senderName)}</span></td>
</tr></table>`;

  const blockHtml = (block: EmailBlock) =>
    block.kind === 'note'
      ? `<p style="margin:20px 0 0;padding:12px 16px;background:${SUNKEN};border-radius:10px;font-size:13px;line-height:1.55;color:${MUTED}">${blockContent(block)}</p>`
      : `<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:${BODY}">${blockContent(block)}</p>`;
  const body = input.blocks.map(blockHtml).join('\n');
  const closing = input.closingBlocks ?? [];

  const button =
    input.action && actionUrl
      ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 0"><tr><td align="center" bgcolor="${color}" style="border-radius:10px;background:${color}"><a href="${escapeHtml(actionUrl)}" style="display:inline-block;padding:14px 28px;border-radius:10px;background:${color};color:${onColor};font-size:16px;font-weight:600;line-height:1.2;text-decoration:none">${escapeHtml(input.action.label)}</a></td></tr></table>
<p style="margin:16px 0 0;font-size:12px;line-height:1.5;color:${FAINT}">${escapeHtml(chrome.buttonFallback)}<br /><span style="word-break:break-all;color:${MUTED}">${escapeHtml(actionUrl)}</span></p>`
      : '';

  const links = (input.links?.items ?? []).map((item) => {
    const url = safeUrl(item.url);
    if (!url)
      throw new Error('El enlace del email no es una URL http(s) válida');
    return { label: item.label, url };
  });
  const linksHtml =
    input.links && links.length > 0
      ? `<p style="margin:20px 0 0;font-size:14px;line-height:1.6;color:${BODY}">${escapeHtml(input.links.lead)} ${links
          .map(
            (l) =>
              `<a href="${escapeHtml(l.url)}" style="color:${linkColor};font-weight:600;text-decoration:underline">${escapeHtml(l.label)}</a>`,
          )
          .join(' · ')}</p>`
      : '';

  const calloutUrl = input.callout ? safeUrl(input.callout.url) : null;
  if (input.callout && !calloutUrl) {
    throw new Error('El enlace del email no es una URL http(s) válida');
  }
  const calloutHtml =
    input.callout && calloutUrl
      ? `<p style="margin:20px 0 0;padding:14px 16px;border:1px solid ${BORDER};border-radius:10px;font-size:14px;line-height:1.6;color:${BODY}">${escapeHtml(input.callout.lead)}<br /><a href="${escapeHtml(calloutUrl)}" style="color:${linkColor};font-weight:600;text-decoration:underline">${escapeHtml(input.callout.label)}</a></p>`
      : '';

  const tables = input.tables ?? [];
  const tablesHtml = [
    ...tables.map((t) => tableHtml(t, linkColor)),
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
      ? `<p style="margin:8px 0 0;font-size:12px;line-height:1.5;color:${FAINT}">${escapeHtml(input.footerLink.lead)} <a href="${escapeHtml(footerUrl)}" style="color:${MUTED};text-decoration:underline">${escapeHtml(input.footerLink.label)}</a></p>`
      : '';

  const preheader = escapeHtml(preheaderText(input.blocks));

  const html = `<!doctype html>
<html lang="${escapeHtml(chrome.htmlLang)}">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="color-scheme" content="light only" /><meta name="supported-color-schemes" content="light" /><title>${escapeHtml(singleLine(input.subject))}</title></head>
<body style="margin:0;padding:0;background:${CANVAS};font-family:${FONT_STACK};-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${preheader}&#8203;&#160;&#8203;&#160;&#8203;&#160;&#8203;&#160;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CANVAS}">
<tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background:#FFFFFF;border:1px solid ${BORDER_SUBTLE};border-radius:16px;overflow:hidden">
<tr><td height="6" style="height:6px;background:${color};font-size:0;line-height:0">&#160;</td></tr>
<tr><td style="padding:28px 32px 0">${header}</td></tr>
<tr><td style="padding:24px 32px 32px">
<h1 style="margin:0 0 16px;font-size:24px;line-height:1.25;font-weight:700;letter-spacing:-0.01em;color:${INK}">${escapeHtml(input.heading)}</h1>
${body}
${tablesHtml}${button}
${calloutHtml}
${linksHtml}
</td></tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px">
<tr><td align="center" style="padding:20px 24px 0;text-align:center">
<p style="margin:0;font-size:12px;line-height:1.5;color:${FAINT}">${footer}</p>
${footerLink}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const textParts = [
    senderName,
    '',
    singleLine(input.heading),
    '',
    ...input.blocks.flatMap(blockLines),
  ];
  for (const table of tables) textParts.push('', ...tableText(table));
  if (closing.length > 0) {
    textParts.push('', ...closing.flatMap(blockLines));
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
