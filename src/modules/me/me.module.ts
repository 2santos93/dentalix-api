import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MeController } from './presentation/me.controller';
import { GetMyProfileUseCase } from './application/use-cases/get-my-profile.use-case';
import { UpdateMyNameUseCase } from './application/use-cases/update-my-name.use-case';
import { ChangeMyPasswordUseCase } from './application/use-cases/change-my-password.use-case';
import { SetMyAvatarUseCase } from './application/use-cases/set-my-avatar.use-case';
import { RemoveMyAvatarUseCase } from './application/use-cases/remove-my-avatar.use-case';
import { USER_PROFILE_REPOSITORY } from './domain/ports/user-profile-repository.port';
import { PrismaUserProfileRepository } from './infrastructure/repositories/prisma-user-profile.repository';
import { PasswordService } from '../../shared/crypto/password.service';
import { TokenService } from '../../shared/crypto/token.service';
import { StorageModule } from '../../shared/storage/storage.module';

// JwtModule.register({}) + TokenService: JwtAuthGuard depende de TokenService
// (patrón de patients.module). StorageModule aporta FILE_STORAGE.
@Module({
  imports: [JwtModule.register({}), StorageModule],
  controllers: [MeController],
  providers: [
    GetMyProfileUseCase,
    UpdateMyNameUseCase,
    ChangeMyPasswordUseCase,
    SetMyAvatarUseCase,
    RemoveMyAvatarUseCase,
    PasswordService,
    TokenService,
    { provide: USER_PROFILE_REPOSITORY, useClass: PrismaUserProfileRepository },
  ],
})
export class MeModule {}
