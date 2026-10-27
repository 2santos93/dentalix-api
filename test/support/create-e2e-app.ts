import { INestApplication, Type } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import {
  ConfigureAppOptions,
  configureApp,
} from '../../src/config/configure-app';

export interface E2eAppOptions extends ConfigureAppOptions {
  /** Controladores extra solo para el test (p. ej. rutas que fallan). */
  controllers?: Type[];
  /** Para `overrideProvider(...)` antes de compilar. */
  override?: (builder: TestingModuleBuilder) => void;
}

/**
 * App de e2e montada EXACTAMENTE como main.ts (configureApp): observabilidad,
 * filtro global de errores, seguridad, límites de cuerpo, prefijo y
 * validación. El log sigue LOG_LEVEL, `silent` en los e2e (setup-e2e.ts).
 */
export async function createE2eApp(
  options: E2eAppOptions = {},
): Promise<INestApplication<App>> {
  const builder = Test.createTestingModule({
    imports: [AppModule],
    controllers: options.controllers ?? [],
  });
  options.override?.(builder);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configureApp(app, options);
  await app.init();
  // Reserve IPv4 before Supertest can bind :: and target a different listener.
  await app.listen(0, '127.0.0.1');
  return app;
}
