import { Global, Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { VerifiedDomainOrigins } from './verified-domain-origins';

/**
 * SEC-021: una sola caché de dominios propios VERIFIED por proceso, global para
 * que la compartan CORS (applySecurity), el check de Origin del refresh
 * (SessionCookieService) y quien la invalida (verificar / eliminar dominio).
 */
@Global()
@Module({
  providers: [
    {
      provide: VerifiedDomainOrigins,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => new VerifiedDomainOrigins(prisma),
    },
  ],
  exports: [VerifiedDomainOrigins],
})
export class VerifiedDomainOriginsModule {}
