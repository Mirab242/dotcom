import { Injectable } from '@nestjs/common';
import { analyzeMarket } from '@dot-trader/trading-engine';
import { Timeframe } from '@dot-trader/exchange-connectors';
import { MarketService } from '../market/market.service';

@Injectable()
export class SignalsService {
  constructor(private marketService: MarketService) {}

  /**
   * Timeframe "fond" fixe pour le contexte multi-timeframe avancé (§4.3) — pas encore
   * configurable par appelant. Idéalement 1d (vrai macro), mais un compte Binance testnet
   * frais n'a souvent que quelques jours d'historique quotidien (l'exchange ne renvoie que ce
   * qui existe depuis sa création) — 1h reste sous ce plafond avec largement assez de bougies
   * pour une EMA50 significative. À repasser en '1d' quand l'historique réel le permettra.
   */
  private readonly MACRO_TIMEFRAME: Timeframe = '1h';

  async getSignal(
    symbol: string,
    timeframe: Timeframe,
    higherTimeframe: Timeframe,
    minConfidence?: number,
  ) {
    const fetchMacro = higherTimeframe !== this.MACRO_TIMEFRAME;

    const [candles, higherTfCandles, macroTfCandles] = await Promise.all([
      this.marketService.getAndStoreCandles(symbol, timeframe, 100),
      this.marketService.getAndStoreCandles(symbol, higherTimeframe, 60),
      fetchMacro ? this.marketService.getAndStoreCandles(symbol, this.MACRO_TIMEFRAME, 60) : Promise.resolve(undefined),
    ]);

    return analyzeMarket({ symbol, candles, higherTfCandles, macroTfCandles, minConfidence });
  }
}
