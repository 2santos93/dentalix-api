import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      validate: (env: Record<string, unknown>) => {
        const required = [
          'DATABASE_URL',
          'JWT_ACCESS_SECRET',
          'JWT_REFRESH_SECRET',
        ];
        for (const key of required) {
          if (env[key] == null || env[key] === '') {
            throw new Error(`Missing required env var: ${key}`);
          }
        }
        return env;
      },
    }),
  ],
})
export class ConfigModule {}
