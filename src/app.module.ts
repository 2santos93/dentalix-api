import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthController } from './health/health.controller';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './shared/prisma/prisma.module';
import { TenantContextModule } from './shared/tenancy/tenant-context.module';
import { AuthModule } from './modules/auth/auth.module';
import { PatientsModule } from './modules/patients/patients.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    TenantContextModule,
    AuthModule,
    PatientsModule,
  ],
  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule {}
