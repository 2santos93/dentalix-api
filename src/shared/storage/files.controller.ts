import { promises as fs } from 'fs';
import * as path from 'path';
import {
  BadRequestException,
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

@ApiTags('files')
@Controller('files')
export class FilesController {
  constructor(private readonly config: ConfigService) {}

  private root(): string {
    return this.config.get<string>('STORAGE_DIR') ?? './storage';
  }

  @Get('avatars/:name')
  // helmet deja CORP en same-origin para toda la API; los avatares son la
  // excepción porque la web (otro origen, y dominios de marca blanca) los
  // incrusta con <img>.
  @Header('Cross-Origin-Resource-Policy', 'cross-origin')
  async getAvatar(
    @Param('name') name: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    if (!SAFE_NAME.test(name)) {
      throw new BadRequestException('Invalid file name');
    }
    const filePath = path.join(this.root(), 'avatars', name);
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(filePath);
    } catch {
      throw new NotFoundException('File not found');
    }
    const mime =
      MIME_BY_EXT[path.extname(name).toLowerCase()] ??
      'application/octet-stream';
    res.set('Content-Type', mime);
    return new StreamableFile(bytes);
  }
}
