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

  const body = input.blocks
    .map((block) =>
      block.kind === 'note'
        ? `<p style="margin:16px 0 0;font-size:13px;line-height:1.5;color:#5b6472">${escapeHtml(block.text)}</p>`
        : `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#1f2933">${escapeHtml(block.text)}</p>`,
    )
    .join('\n');

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
${button}
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
  if (input.action && actionUrl) {
    textParts.push('', `${singleLine(input.action.label)}: ${actionUrl}`);
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
