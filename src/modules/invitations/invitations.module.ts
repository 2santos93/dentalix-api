import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { StaffInvitationsController } from './presentation/staff-invitations.controller';
import { PublicInvitationsController } from './presentation/public-invitations.controller';
import { CreateInvitationUseCase } from './application/use-cases/create-invitation.use-case';
import { ListInvitationsUseCase } from './application/use-cases/list-invitations.use-case';
import { RevokeInvitationUseCase } from './application/use-cases/revoke-invitation.use-case';
import { GetInvitationUseCase } from './application/use-cases/get-invitation.use-case';
import { AcceptInvitationUseCase } from './application/use-cases/accept-invitation.use-case';
import { INVITATION_REPOSITORY } from './domain/ports/invitation-repository.port';
import { PrismaInvitationRepository } from './infrastructure/repositories/prisma-invitation.repository';
import { TokenService } from '../../shared/crypto/token.service';
import { PasswordService } from '../../shared/crypto/password.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { PublicTenantContextInterceptor } from '../../shared/tenancy/public-tenant-context.interceptor';

@Module({
  // JwtModule.register({}) mirrors StaffModule: JwtAuthGuard (applied on
  // StaffInvitationsController) depends on TokenService, which depends on
  // JwtService — must be available here.
  imports: [JwtModule.register({})],
  controllers: [StaffInvitationsController, PublicInvitationsController],
  providers: [
    CreateInvitationUseCase,
    ListInvitationsUseCase,
    RevokeInvitationUseCase,
    GetInvitationUseCase,
    AcceptInvitationUseCase,
    PasswordService,
    TokenService,
    // Both interceptors only depend on the @Global TenantContextService;
    // listing them here makes them resolvable for @UseInterceptors on their
    // respective controllers (same convention as StaffModule/
    // PublicBrandingModule).
    TenantContextInterceptor,
    PublicTenantContextInterceptor,
    { provide: INVITATION_REPOSITORY, useClass: PrismaInvitationRepository },
  ],
})
export class InvitationsModule {}
