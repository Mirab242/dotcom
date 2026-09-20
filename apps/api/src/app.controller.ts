import { Controller, Get, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { join } from 'path';
import { ExchangeService } from './exchange/exchange.service';
import { isPersonalMode } from './common/personal-mode.util';

/**
 * Sert le frontend statique (apps/web/demo.html) directement depuis l'API — un seul
 * service à déployer/pointer avec un sous-domaine, pas besoin d'un hébergement séparé
 * pour le front tant qu'il reste un simple fichier HTML autonome.
 */
@Controller()
export class AppController {
  constructor(
    private config: ConfigService,
    private exchangeService: ExchangeService,
  ) {}

  @Get()
  serveFrontend(@Res() res: Response) {
    res.sendFile(join(process.cwd(), 'apps', 'web', 'demo.html'));
  }

  /**
   * Configuration publique minimale, lue par la page AVANT connexion : masquer l'inscription en mode
   * personnel, et afficher clairement si l'on est en testnet ou en argent RÉEL. N'expose que deux
   * indicateurs, aucun secret ni chemin de configuration.
   */
  @Get('config')
  publicConfig() {
    return { personalMode: isPersonalMode(this.config), mode: this.exchangeService.getActiveMode() };
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
