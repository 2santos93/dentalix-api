import {
  collectControllers,
  discoverRoutes,
} from '../test/support/route-discovery';
import { AppModule } from './app.module';
import {
  PUBLIC_WITHOUT_NO_STORE,
  isNoStoreExempt,
} from '../test/support/public-no-store';
import { NoStoreHeadersInterceptor } from './shared/http/no-store-headers.interceptor';
import { JwtAuthGuard } from './modules/auth/presentation/guards/jwt-auth.guard';

// Igual que auth-matrix.spec.ts: el ConfigModule real valida el entorno al
// importarse y no declara controladores.
jest.mock('./config/config.module', () => ({
  ConfigModule: class ConfigModule {},
}));

/**
 * SEC-064: toda ruta pública (la que no pasa por JwtAuthGuard: enlaces por
 * token del paciente, login, registro, recuperación de contraseña...) responde
 * con `Cache-Control: no-store` y `Pragma: no-cache`
 * (NoStoreHeadersInterceptor). Este test recorre las rutas REALES de AppModule:
 * una ruta pública nueva sin el interceptor lo rompe.
 *
 * Quedan fuera solo las que no llevan datos personales ni tokens y tienen su
 * propia política de caché: la raíz, la salud (sondas del orquestador) y los
 * ficheros estáticos (avatares y logos, con ETag; la subida y la URL firmada
 * del adaptador de disco, solo en desarrollo).
 */

describe('Rutas públicas sin caché (SEC-064)', () => {
  const routes = discoverRoutes(collectControllers(AppModule));
  const isPublic = (r: (typeof routes)[number]) =>
    !r.guards.some(
      (g) =>
        g === JwtAuthGuard ||
        g instanceof (JwtAuthGuard as new (...a: never[]) => object),
    );
  const publicRoutes = routes.filter(isPublic);
  const hasNoStore = (r: (typeof routes)[number]) =>
    r.interceptors.some(
      (i) =>
        i === NoStoreHeadersInterceptor ||
        i instanceof NoStoreHeadersInterceptor,
    );

  it('recorre las rutas públicas de verdad (enlaces por token incluidos)', () => {
    const keys = publicRoutes.map((r) => r.key);
    expect(keys.length).toBeGreaterThan(30);
    expect(keys).toEqual(
      expect.arrayContaining([
        'GET /public/slot-offers/:token',
        'POST /public/slot-offers/:token/accept',
        'GET /public/signed-consent-copies/:token',
        'POST /public/signed-consent-copies/:token/download',
        'GET /public/medical-history/:token',
        'GET /public/sign/:token',
        'POST /public/appointment-confirmations/:token',
        'POST /auth/login',
      ]),
    );
  });

  it('toda ruta pública lleva NoStoreHeadersInterceptor, salvo la raíz, la salud y los ficheros', () => {
    const sinNoStore = publicRoutes
      .filter((r) => !isNoStoreExempt(r.key))
      .filter((r) => !hasNoStore(r))
      .map((r) => `${r.key} (${r.controller}.${r.handler})`);
    expect(sinNoStore).toEqual([]);
  });

  it('las excepciones existen (no quedan patrones muertos)', () => {
    for (const re of PUBLIC_WITHOUT_NO_STORE) {
      expect(publicRoutes.some((r) => re.test(r.key))).toBe(true);
    }
  });

  it('ninguna ruta con sesión es una excepción por error', () => {
    const conSesion = routes.filter((r) => !isPublic(r));
    expect(conSesion.filter((r) => isNoStoreExempt(r.key))).toEqual([]);
  });
});
