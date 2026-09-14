import { Candle, OrderSide } from '@dot-trader/shared-types';
import { analyzeMarket } from './engine';

export interface BacktestTrade {
  side: OrderSide;
  entry: number;
  exit: number;
  stopLoss: number;
  takeProfit: number;
  outcome: 'tp' | 'sl';
  rMultiple: number;
  pnl: number;
  entryIndex: number;
  exitIndex: number;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  equityCurve: number[]; // valeur du capital après chaque bougie
  startingEquity: number;
  endingEquity: number;
  winRate: number; // 0-100
  profitFactor: number | null; // null si aucune perte (division par zéro évitée)
  maxDrawdownPct: number; // 0-100
  averageR: number;
  totalTrades: number;
}

export interface BacktestConfig {
  startingEquity?: number;
  riskPct?: number; // % du capital risqué par trade
  minConfidence?: number;
  minHistory?: number; // nb de bougies minimum avant de commencer à chercher des signaux
}

/**
 * Rejoue l'historique bougie par bougie à travers le MÊME moteur (analyzeMarket) que le live —
 * aucune logique dupliquée, conformément à §4.7 de l'architecture.
 *
 * Simplification assumée : par manque d'un historique multi-timeframe aligné, le filtre de
 * "tendance supérieure" est ici évalué sur la même série (equivaut à un simple filtre EMA50
 * long terme plutôt qu'un vrai 4h). À corriger quand l'ingestion multi-timeframe existera.
 * Une seule position ouverte à la fois (pas de pyramiding), sortie sur SL ou TP1 uniquement
 * (pas de sorties partielles TP2/TP3 dans cette V1 du backtester).
 */
export function runBacktest(candles: Candle[], config: BacktestConfig = {}): BacktestResult {
  const startingEquity = config.startingEquity ?? 1000;
  const riskPct = config.riskPct ?? 1;
  const minHistory = config.minHistory ?? 50;

  let equity = startingEquity;
  const equityCurve: number[] = [];
  const trades: BacktestTrade[] = [];

  let openTrade: {
    side: OrderSide;
    entry: number;
    stopLoss: number;
    takeProfit: number;
    riskAmount: number;
    entryIndex: number;
  } | null = null;

  for (let i = minHistory; i < candles.length; i++) {
    const window = candles.slice(0, i + 1);
    const bar = candles[i];

    if (openTrade) {
      // Vérifie si le SL ou le TP1 a été touché sur cette bougie (intrabar, via high/low).
      const { side, stopLoss, takeProfit, riskAmount, entry, entryIndex } = openTrade;
      const hitSl = side === OrderSide.BUY ? bar.low <= stopLoss : bar.high >= stopLoss;
      const hitTp = side === OrderSide.BUY ? bar.high >= takeProfit : bar.low <= takeProfit;

      // Si les deux sont touchés sur la même bougie, on suppose le pire cas (SL) — conservateur.
      if (hitSl || hitTp) {
        const outcome: 'tp' | 'sl' = hitSl && !hitTp ? 'sl' : hitSl ? 'sl' : 'tp';
        const exitPrice = outcome === 'sl' ? stopLoss : takeProfit;
        const rMultiple = outcome === 'sl' ? -1 : Math.abs(takeProfit - entry) / Math.abs(entry - stopLoss);
        const pnl = riskAmount * rMultiple;
        equity += pnl;
        trades.push({
          side,
          entry,
          exit: exitPrice,
          stopLoss,
          takeProfit,
          outcome,
          rMultiple,
          pnl,
          entryIndex,
          exitIndex: i,
        });
        openTrade = null;
      }
    } else {
      const signal = analyzeMarket({
        symbol: 'BACKTEST',
        candles: window,
        higherTfCandles: window, // simplification assumée — voir commentaire ci-dessus
        minConfidence: config.minConfidence,
      });
      if (signal) {
        const riskAmount = equity * (riskPct / 100);
        openTrade = {
          side: signal.side,
          entry: signal.entry,
          stopLoss: signal.stopLoss,
          takeProfit: signal.takeProfits[0],
          riskAmount,
          entryIndex: i,
        };
      }
    }

    equityCurve.push(equity);
  }

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  let peak = startingEquity;
  let maxDrawdownPct = 0;
  for (const value of equityCurve) {
    if (value > peak) peak = value;
    const dd = peak > 0 ? ((peak - value) / peak) * 100 : 0;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }

  return {
    trades,
    equityCurve,
    startingEquity,
    endingEquity: equity,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    maxDrawdownPct,
    averageR: trades.length ? trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length : 0,
    totalTrades: trades.length,
  };
}
