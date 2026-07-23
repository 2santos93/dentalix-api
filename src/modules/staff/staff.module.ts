import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { StaffController } from './presentation/staff.controller';
import { ListStaffUseCase } from './application/use-cases/list-staff.use-case';
import { STAFF_REPOSITORY } from './domain/ports/staff-repository.port';
import { PrismaStaffRepository } from './infrastructure/repositories/prisma-staff.repository';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';

@Module({
  // JwtModule.register({}) mirrors PatientsModule/AppointmentsModule:
  // JwtAuthGuard depends on TokenService, which depends on JwtService — must
  // be available here since the guard is applied on this module's controller.
  imports: [JwtModule.register({})],
  controllers: [StaffController],
  providers: [
    ListStaffUseCase,
    TokenService,
    // TenantContextInterceptor only depends on the @Global TenantContextService;
    // listing it here makes it resolvable for @UseInterceptors on StaffController.
    TenantContextInterceptor,
    { provide: STAFF_REPOSITORY, useClass: PrismaStaffRepository },
  ],
})
export class StaffModule {}
