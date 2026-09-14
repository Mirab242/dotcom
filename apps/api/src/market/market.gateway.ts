import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { ExchangeService } from '../exchange/exchange.service';

// Marchés actifs de la plateforme (§ roadmap Phase 7 "extension multi-actifs") — ajouter un
// symbole ici suffit à le pousser en direct, aucun autre changement nécessaire côté gateway.
const ACTIVE_SYMBOLS = ['DOT/USDT', 'BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
const POLL_INTERVAL_MS = 3000;

/**
 * Pousse le prix en direct aux clients connectés au lieu de les laisser sonder l'API en boucle
 * (§ roadmap Phase 1 "WebSocket live"). ccxt (non-pro) n'a pas de flux WS natif ici, donc le
 * serveur continue d'interroger Binance testnet en REST côté back — la différence pour le
 * navigateur est réelle : un vrai push serveur→client au lieu d'un fetch() périodique.
 */
@WebSocketGateway({ cors: { origin: '*' } })
export class MarketGateway implements OnGatewayConnection, OnModuleInit, OnModuleDestroy {
  @WebSocketServer() server: Server;

  private readonly logger = new Logger(MarketGateway.name);
  private timer?: ReturnType<typeof setInterval>;
  private lastPrices = new Map<string, number>();

  constructor(private exchangeService: ExchangeService) {}

  onModuleInit() {
    this.timer = setInterval(() => this.pollAndBroadcast(), POLL_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  handleConnection(client: Socket) {
    for (const [symbol, price] of this.lastPrices) {
      client.emit('price', { symbol, price, ts: Date.now() });
    }
  }

  private async pollAndBroadcast() {
    if (!this.server) return;
    await Promise.all(ACTIVE_SYMBOLS.map((symbol) => this.pollSymbol(symbol)));
  }

  private async pollSymbol(symbol: string) {
    try {
      const [candle] = await this.exchangeService.getConnector().getCandles(symbol, '1m', 1);
      if (candle && candle.close !== this.lastPrices.get(symbol)) {
        this.lastPrices.set(symbol, candle.close);
        this.server.emit('price', { symbol, price: candle.close, ts: Date.now() });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erreur inconnue';
      this.logger.warn(`Diffusion du prix live (${symbol}) échouée : ${message}`);
    }
  }
}
