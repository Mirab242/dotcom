import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BinanceConnector, ExchangeConnector } from '@dot-trader/exchange-connectors';
import { PrismaService } from '../prisma/prisma.service';
import { decryptSecret } from '../common/crypto.util';

/**
 * Charge le connecteur d'échange actif. Deux garde-fous avant de risquer de l'argent réel :
 *  1. Le mode ("testnet" | "live") est déterminé par LIVE_TRADING_ENABLED côté serveur, jamais
 *     par un flag envoyé par un client — impossible de "passer en réel" par erreur depuis l'UI.
 *  2. Les credentials "live" doivent exister, chiffrés, dans `platform_exchange_accounts`
 *     (voir AdminExchangeController) — pas de repli silencieux sur des clés testnet en .env :
 *     si le mode live est activé sans compte live configuré, le connecteur refuse de démarrer
 *     plutôt que de trader avec les mauvaises clés.
 */
@Injectable()
export class ExchangeService implements OnModuleInit {
  private readonly logger = new Logger(ExchangeService.name);
  private connector: ExchangeConnector | null = null;
  private activeMode: 'testnet' | 'live' = 'testnet';

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
  ) {}

  async onModuleInit() {
    this.activeMode = this.config.get<string>('LIVE_TRADING_ENABLED') === 'true' ? 'live' : 'testnet';
    await this.loadConnector();
  }

  /** Recharge le connecteur depuis la base — appelé après qu'un admin configure/change des credentials. */
  async loadConnector() {
    const account = await this.prisma.platformExchangeAccount.findFirst({
      where: { exchange: 'binance', mode: this.activeMode, status: 'active' },
      orderBy: { createdAt: 'desc' },
    });

    if (account) {
      const encryptionKey = this.config.get<string>('ENCRYPTION_KEY');
      if (!encryptionKey) {
        this.logger.error('ENCRYPTION_KEY absente — impossible de déchiffrer les credentials exchange stockés.');
        this.connector = null;
        return;
      }
      const apiKey = decryptSecret(account.apiKeyEncrypted, encryptionKey);
      const apiSecret = decryptSecret(account.apiSecretEncrypted, encryptionKey);
      this.connector = new BinanceConnector({ apiKey, apiSecret, mode: this.activeMode });
      this.logger.log(`Connecteur Binance (${this.activeMode}) chargé depuis la base (compte ${account.id}).`);
      return;
    }

    if (this.activeMode === 'live') {
      // Volontairement AUCUN repli sur .env en mode live : un compte live doit être configuré
      // explicitement via l'admin (encrypté en base), jamais via une variable d'environnement en clair.
      this.logger.error(
        'LIVE_TRADING_ENABLED=true mais aucun compte Binance "live" configuré (POST /admin/exchange-account) — connecteur non initialisé.',
      );
      this.connector = null;
      return;
    }

    // Mode testnet, rien en base : repli sur .env pour ne pas casser le dev local existant.
    const apiKey = this.config.get<string>('BINANCE_TESTNET_API_KEY');
    const apiSecret = this.config.get<string>('BINANCE_TESTNET_API_SECRET');
    if (!apiKey || !apiSecret) {
      this.logger.warn('BINANCE_TESTNET_API_KEY/SECRET absents — connecteur non initialisé.');
      this.connector = null;
      return;
    }
    this.connector = new BinanceConnector({ apiKey, apiSecret, mode: 'testnet' });
  }

  getActiveMode(): 'testnet' | 'live' {
    return this.activeMode;
  }

  getConnector(): ExchangeConnector {
    if (!this.connector) {
      throw new ServiceUnavailableException(
        this.activeMode === 'live'
          ? "Connecteur Binance live non configuré — un admin doit d'abord enregistrer un compte via POST /admin/exchange-account."
          : "Connecteur Binance testnet non configuré — renseignez BINANCE_TESTNET_API_KEY/SECRET dans apps/api/.env (clés à générer sur testnet.binance.vision), puis redémarrez l'API.",
      );
    }
    return this.connector;
  }
}
