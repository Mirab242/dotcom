import { EMA, RSI, MACD, ATR } from 'technicalindicators';
import { Candle } from '@dot-trader/shared-types';

export function closes(candles: Candle[]): number[] {
  return candles.map((c) => c.close);
}

export function emaLast(candles: Candle[], period: number): number | null {
  const values = EMA.calculate({ period, values: closes(candles) });
  return values.length ? values[values.length - 1] : null;
}

export function rsiLast(candles: Candle[], period = 14): number | null {
  const values = RSI.calculate({ period, values: closes(candles) });
  return values.length ? values[values.length - 1] : null;
}

export interface MacdResult {
  macd: number;
  signal: number;
  histogram: number;
}
export function macdLast(candles: Candle[]): MacdResult | null {
  const values = MACD.calculate({
    values: closes(candles),
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const last = values[values.length - 1];
  if (!last || last.MACD === undefined || last.signal === undefined || last.histogram === undefined) {
    return null;
  }
  return { macd: last.MACD, signal: last.signal, histogram: last.histogram };
}

export function atrLast(candles: Candle[], period = 14): number | null {
  const values = ATR.calculate({
    period,
    high: candles.map((c) => c.high),
    low: candles.map((c) => c.low),
    close: candles.map((c) => c.close),
  });
  return values.length ? values[values.length - 1] : null;
}

export function volumeAvg(candles: Candle[], period = 20): number {
  const recent = candles.slice(-period);
  return recent.reduce((sum, c) => sum + c.volume, 0) / (recent.length || 1);
}

/** Support/résistance simplifiés : plus haut / plus bas des N dernières bougies (hors la courante). */
export function recentSwing(candles: Candle[], lookback = 20): { support: number; resistance: number } {
  const window = candles.slice(-lookback - 1, -1);
  return {
    support: Math.min(...window.map((c) => c.low)),
    resistance: Math.max(...window.map((c) => c.high)),
  };
}
