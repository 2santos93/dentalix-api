/**
 * DX-564: dominios de primer nivel (TLD) públicos que WhatsApp, Gmail o iOS
 * convierten en enlace aunque el texto no lleve `http://` («ejemplo.com»,
 * «bit.ly», «x.com», «tienda.com.ve»). Las indicaciones previas a la cita no
 * admiten enlaces: un «palabra.tld» con uno de estos TLD cuenta como enlace.
 *
 * Lista CERRADA a propósito, en minúsculas (la comparación no distingue
 * mayúsculas): con «cualquier palabra tras un punto» se marcaría texto
 * corriente escrito sin espacio («6h.Trae», «Dr.Pérez», «Sr.García»). Cubre
 * los genéricos más usados y los códigos de país de los mercados del producto
 * y de los más frecuentes en spam. Coste aceptado: un TLD que también es una
 * palabra corta y va pegado a un punto se marca («ayunas.No coma» → «.no», de
 * Noruega); el mensaje pide escribirlo como texto y basta con un espacio.
 *
 * Para añadir uno: en minúsculas, aquí, y un caso en
 * `appointment-type-rules.spec.ts`.
 */
export const LINK_TLDS: ReadonlySet<string> = new Set([
  // Genéricos.
  'com',
  'net',
  'org',
  'info',
  'biz',
  'edu',
  'gov',
  'io',
  'ai',
  'app',
  'dev',
  'me',
  'ly',
  'gl',
  'to',
  'tv',
  'co',
  'xyz',
  'site',
  'online',
  'shop',
  'store',
  'link',
  'page',
  'top',
  'club',
  'live',
  'pro',
  'mobi',
  'health',
  'clinic',
  'dental',
  'dentist',
  // Códigos de país: América.
  've',
  'mx',
  'ar',
  'cl',
  'pe',
  'ec',
  'uy',
  'py',
  'bo',
  'br',
  'us',
  'ca',
  'pa',
  'cr',
  'do',
  'gt',
  'hn',
  'sv',
  'ni',
  'cu',
  'pr',
  // Códigos de país: Europa y resto.
  'es',
  'uk',
  'de',
  'fr',
  'it',
  'pt',
  'nl',
  'be',
  'ch',
  'at',
  'ie',
  'no',
  'se',
  'dk',
  'fi',
  'pl',
  'ru',
  'eu',
  'au',
  'nz',
  'in',
  'cn',
  'jp',
  'kr',
  'za',
  'ws',
]);
