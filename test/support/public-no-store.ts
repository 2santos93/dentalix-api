/**
 * SEC-064: las rutas públicas (sin JwtAuthGuard) que NO llevan
 * `Cache-Control: no-store`: la raíz, la salud (sondas del orquestador) y los
 * ficheros estáticos (avatares y logos con ETag; la subida y la URL firmada del
 * adaptador de disco, solo en desarrollo). Ninguna lleva datos personales ni
 * tokens. La comparten `src/public-no-store.spec.ts` y
 * `test/public-no-store.e2e-spec.ts`.
 */
export const PUBLIC_WITHOUT_NO_STORE: RegExp[] = [
  /^GET \/$/,
  /^GET \/health(\/ready)?$/,
  /^(GET|POST) \/files\//,
];

export function isNoStoreExempt(routeKey: string): boolean {
  return PUBLIC_WITHOUT_NO_STORE.some((re) => re.test(routeKey));
}
