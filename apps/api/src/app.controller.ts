import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { join } from 'path';

/**
 * Sert le frontend statique (apps/web/demo.html) directement depuis l'API — un seul
 * service à déployer/pointer avec un sous-domaine, pas besoin d'un hébergement séparé
 * pour le front tant qu'il reste un simple fichier HTML autonome.
 */
@Controller()
export class AppController {
  @Get()
  serveFrontend(@Res() res: Response) {
    res.sendFile(join(process.cwd(), 'apps', 'web', 'demo.html'));
  }

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Get('legal/mentions-legales')
  serveMentionsLegales(@Res() res: Response) {
    res.sendFile(join(process.cwd(), 'apps', 'web', 'mentions-legales.html'));
  }

  @Get('legal/cgu')
  serveCgu(@Res() res: Response) {
    res.sendFile(join(process.cwd(), 'apps', 'web', 'cgu.html'));
  }

  @Get('legal/confidentialite')
  serveConfidentialite(@Res() res: Response) {
    res.sendFile(join(process.cwd(), 'apps', 'web', 'confidentialite.html'));
  }
}
