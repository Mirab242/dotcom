import { Candle, OrderSide, Signal } from '@dot-trader/shared-types';
import { atrLast, emaLast, macdLast, recentSwing, rsiLast, volumeAvg } from './indicators';

export interface AnalyzeInput {
  symbol: string;
  /** Bougies du timeframe d'exécution (ex: 15m), les plus récentes en dernier. */
  candles: Candle[];
  /** Bougies d'un timeframe supérieur (ex: 4h), utilisées uniquement pour le filtre de tendance. */
  higherTfCandles: Candle[];
  /**
   * Bougies d'un timeframe macro (ex: 1d) — optionnel. Sert à un vrai contexte multi-timeframe
   * à 3 niveaux : renforce le score quand exécution/4h/macro s'alignent, le pénalise quand le
   * signal va à contre-courant de la tendance de fond. Omis (ex: backtest sans historique
   * macro aligné) → ce critère est simplement ignoré, aucun signal n'est bloqué pour autant.
   */
  macroTfCandles?: Candle[];
  /** Score minimum (0-100) pour émettre un signal. Par défaut 60. */
  minConfidence?: number;
}

interface Criterion {
  label: string;
  points: number; // contribution positive = plutôt LONG, négative = plutôt SHORT, 0 = neutre
  reason: string;
}

/**
 * Pipeline pur (aucun I/O) : bougies en entrée → Signal ou null en sortie.
 * Reproduit §4.3 de l'architecture : contexte multi-timeframe, indicateurs,
 * structure de marché, score de confiance, décision.
 */
export function analyzeMarket(input: AnalyzeInput): Signal | null {
  const { symbol, candles, higherTfCandles, macroTfCandles, minConfidence = 60 } = input;
  if (candles.length < 30) return null; // pas assez d'historique pour des indicateurs fiables

  const last = candles[candles.length - 1];
  const criteria: Criterion[] = [];

  // 1. Contexte multi-timeframe : tendance sur le timeframe supérieur (EMA20).
  // EMA20 plutôt que EMA50 : un compte Binance testnet frais n'a souvent que quelques dizaines
  // de bougies 4h d'historique (l'exchange ne renvoie que ce qui existe depuis sa création) —
  // exiger 50 barres y rendait ce critère silencieusement inactif en permanence.
  const higherEma20 = higherTfCandles.length >= 20 ? emaLast(higherTfCandles, 20) : null;
  const higherClose = higherTfCandles.at(-1)?.close ?? null;
  if (higherEma20 !== null && higherClose !== null) {
    const bias = higherClose > higherEma20 ? 1 : -1;
    criteria.push({
      label: 'Tendance supérieure',
      points: bias * 20,
      reason: bias > 0
        ? 'Tendance haussière sur le timeframe supérieur (prix > EMA20)'
        : 'Tendance baissière sur le timeframe supérieur (prix < EMA20)',
    });
  }

  // 2. EMA rapide/lente sur le timeframe d'exécution
  const ema20 = emaLast(candles, 20);
  const ema50 = emaLast(candles, 50);
  if (ema20 !== null && ema50 !== null) {
    const bias = ema20 > ema50 ? 1 : -1;
    criteria.push({
      label: 'EMA 20/50',
      points: bias * 15,
      reason: bias > 0 ? 'EMA20 au-dessus de l\'EMA50 (momentum haussier)' : 'EMA20 sous l\'EMA50 (momentum baissier)',
    });
  }

  // 3. RSI — évite les zones de surachat/survente extrêmes
  const rsi = rsiLast(candles);
  if (rsi !== null) {
    let points = 0;
    let reason = `RSI neutre (${rsi.toFixed(1)})`;
    if (rsi > 70) { points = -10; reason = `RSI en surachat (${rsi.toFixed(1)}) — risque de repli`; }
    else if (rsi < 30) { points = 10; reason = `RSI en survente (${rsi.toFixed(1)}) — rebond possible`; }
    else if (rsi > 50) { points = 5; reason = `RSI au-dessus de 50 (${rsi.toFixed(1)}) — momentum haussier`; }
    else { points = -5; reason = `RSI sous 50 (${rsi.toFixed(1)}) — momentum baissier`; }
    criteria.push({ label: 'RSI', points, reason });
  }

  // 4. MACD — confirmation du momentum
  const macd = macdLast(candles);
  if (macd !== null) {
    const bias = macd.histogram > 0 ? 1 : -1;
    criteria.push({
      label: 'MACD',
      points: bias * 15,
      reason: bias > 0 ? 'Histogramme MACD positif (momentum haussier)' : 'Histogramme MACD négatif (momentum baissier)',
    });
  }

  // 5. Volume — confirme (ou non) le mouvement en cours
  const avgVol = volumeAvg(candles);
  const volRatio = avgVol > 0 ? last.volume / avgVol : 1;
  if (volRatio > 1.2) {
    criteria.push({ label: 'Volume', points: 10, reason: `Volume ${volRatio.toFixed(1)}x la moyenne — mouvement confirmé` });
  } else if (volRatio < 0.6) {
    criteria.push({ label: 'Volume', points: -5, reason: `Volume faible (${volRatio.toFixed(1)}x la moyenne) — mouvement peu fiable` });
  }

  // 6. Structure de marché — position par rapport au dernier support/résistance
  const { support, resistance } = recentSwing(candles);
  const range = resistance - support || 1;
  const posInRange = (last.close - support) / range; // 0 = sur le support, 1 = sur la résistance
  if (posInRange < 0.25) {
    criteria.push({ label: 'Structure', points: 10, reason: 'Prix proche d\'un support récent' });
  } else if (posInRange > 0.75) {
    criteria.push({ label: 'Structure', points: -10, reason: 'Prix proche d\'une résistance récente' });
  }

  // 7. Confluence multi-timeframe avancée (exécution + supérieur + fond) : un signal qui va dans
  // le sens des trois horizons est plus fiable qu'un signal isolé sur le seul timeframe
  // d'exécution ; un conflit franc entre le supérieur et le fond doit au contraire faire douter.
  // EMA50 ici (pas EMA20) : le timeframe "fond" est choisi par l'appelant spécifiquement parce
  // qu'il a assez d'historique pour une moyenne plus lente (voir SignalsService.MACRO_TIMEFRAME).
  const macroEma50 = macroTfCandles && macroTfCandles.length >= 50 ? emaLast(macroTfCandles, 50) : null;
  const macroClose = macroTfCandles?.at(-1)?.close ?? null;
  if (macroEma50 !== null && macroClose !== null && higherEma20 !== null && higherClose !== null) {
    const macroBias = macroClose > macroEma50 ? 1 : -1;
    const higherBias = higherClose > higherEma20 ? 1 : -1;
    const preliminarySide = criteria.reduce((sum, c) => sum + c.points, 0) >= 0 ? 1 : -1;

    if (macroBias === higherBias && macroBias === preliminarySide) {
      criteria.push({
        label: 'Confluence multi-timeframe',
        points: preliminarySide * 15,
        reason: `Tendance alignée sur exécution/supérieur/fond (${macroBias > 0 ? 'haussière' : 'baissière'}) — confluence forte`,
      });
    } else if (macroBias === higherBias && macroBias !== preliminarySide) {
      criteria.push({
        label: 'Confluence multi-timeframe',
        points: -preliminarySide * 10,
        reason: `Signal à contre-courant de la tendance de fond (${macroBias > 0 ? 'haussière' : 'baissière'}) — prudence`,
      });
    } else {
      criteria.push({
        label: 'Confluence multi-timeframe',
        points: -preliminarySide * 5,
        reason: 'Tendances supérieure et de fond en désaccord — contexte peu clair',
      });
    }
  }

  // --- Agrégation ---
  const rawScore = criteria.reduce((sum, c) => sum + c.points, 0);
  const side: OrderSide = rawScore >= 0 ? OrderSide.BUY : OrderSide.SELL;
  const confidence = Math.min(100, Math.round(Math.abs(rawScore) / 100 * 100)); // ~100 = somme max théorique avec confluence

  if (confidence < minConfidence) return null;

  const atr = atrLast(candles) ?? last.close * 0.01; // repli à 1% si ATR indisponible (peu d'historique)
  const entry = last.close;
  const slDistance = atr * 1.5;
  const stopLoss = side === OrderSide.BUY ? entry - slDistance : entry + slDistance;
  const direction = side === OrderSide.BUY ? 1 : -1;
  const takeProfits = [1, 2, 3].map((r) => entry + direction * slDistance * r);

  return {
    symbol,
    side,
    entry,
    stopLoss,
    takeProfits,
    riskRewardRatio: 2, // TP2 = 2R par construction
    confidence,
    reasons: criteria.filter((c) => c.points !== 0).map((c) => c.reason),
    createdAt: new Date().toISOString(),
  };
}
