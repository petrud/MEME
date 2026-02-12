// ============================================================================
// FEATURE ENGINEERING - Near-real-time feature computation
// ============================================================================

import { v4 as uuidv4 } from 'uuid';
import type {
  BotConfig, RegimeFeatures, TokenTractionFeatures,
  ConcentrationFeatures, ExecutionRiskFeatures, AllFeatures, TokenInfo
} from '../../shared/types.js';

// --- In-memory event buffers for real-time feature computation ---

interface PumpEvent {
  type: 'LAUNCH' | 'BUY' | 'SELL' | 'GRADUATION';
  tokenMint: string;
  wallet: string;
  amountSol: number;
  timestamp: number;
}

// Sliding windows
const EVENT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const eventBuffer: PumpEvent[] = [];
const tokenEvents: Map<string, PumpEvent[]> = new Map();

export function recordEvent(event: PumpEvent): void {
  eventBuffer.push(event);
  // Per-token tracking
  if (!tokenEvents.has(event.tokenMint)) {
    tokenEvents.set(event.tokenMint, []);
  }
  tokenEvents.get(event.tokenMint)!.push(event);

  // Prune old events periodically
  const cutoff = Date.now() - EVENT_WINDOW_MS * 2;
  while (eventBuffer.length > 0 && eventBuffer[0].timestamp < cutoff) {
    eventBuffer.shift();
  }
}

// ============================================================================
// REGIME FEATURES
// ============================================================================

export function computeRegimeFeatures(config: BotConfig): RegimeFeatures {
  const now = Date.now();
  const windowStart = now - EVENT_WINDOW_MS;
  const recentEvents = eventBuffer.filter(e => e.timestamp > windowStart);

  // Launch rate: new tokens per 5min window
  const launches = recentEvents.filter(e => e.type === 'LAUNCH').length;
  const launchRate = launches; // per 5-min window

  // Volume proxy: total SOL volume in buys
  const buyVolume = recentEvents
    .filter(e => e.type === 'BUY')
    .reduce((sum, e) => sum + e.amountSol, 0);

  // Graduation rate
  const graduations = recentEvents.filter(e => e.type === 'GRADUATION').length;

  // SOL volatility proxy (simplified: use event volume variance as proxy)
  // In production, this would use actual SOL/USD price feed
  const solVolatility = Math.min(buyVolume / 100, 1.0); // Normalized 0-1

  // Composite regime score
  // High launch rate + high volume + graduations = mania
  const launchScore = Math.min(launchRate / 20, 1.0) * 30;  // 0-30
  const volumeScore = Math.min(buyVolume / 500, 1.0) * 40;   // 0-40
  const gradScore = Math.min(graduations / 5, 1.0) * 30;     // 0-30
  const regimeScore = Math.round(launchScore + volumeScore + gradScore);

  let regime: 'MANIA' | 'NORMAL' | 'COLD';
  let reason: string;
  if (regimeScore >= 70) {
    regime = 'MANIA';
    reason = `High activity: ${launches} launches, ${buyVolume.toFixed(1)} SOL volume, ${graduations} graduations in 5min`;
  } else if (regimeScore >= config.regimeScoreThreshold) {
    regime = 'NORMAL';
    reason = `Moderate activity: ${launches} launches, ${buyVolume.toFixed(1)} SOL volume in 5min`;
  } else {
    regime = 'COLD';
    reason = `Low activity: ${launches} launches, ${buyVolume.toFixed(1)} SOL volume in 5min. Below threshold ${config.regimeScoreThreshold}.`;
  }

  return {
    pumpfunLaunchRate: launchRate,
    pumpfunVolumeProxy: buyVolume,
    solVolatility,
    marketRiskOn: regimeScore >= config.regimeScoreThreshold,
    regimeScore,
    regime,
    reason,
  };
}

// ============================================================================
// TOKEN TRACTION FEATURES
// ============================================================================

export function computeTractionFeatures(
  tokenMint: string,
  tokenInfo: TokenInfo
): TokenTractionFeatures {
  const now = Date.now();
  const events = (tokenEvents.get(tokenMint) || []).filter(
    e => e.timestamp > now - EVENT_WINDOW_MS
  );

  const buys = events.filter(e => e.type === 'BUY');
  const sells = events.filter(e => e.type === 'SELL');

  // Unique buyers per minute
  const uniqueBuyers = new Set(buys.map(b => b.wallet)).size;
  const windowMinutes = EVENT_WINDOW_MS / 60_000;
  const uniqueBuyersPerMin = uniqueBuyers / windowMinutes;

  // Net buy pressure
  const totalTrades = buys.length + sells.length;
  const netBuyPressure = totalTrades > 0 ? (buys.length - sells.length) / totalTrades : 0;

  // Buy size distribution
  const buyCountSmall = buys.filter(b => b.amountSol < 0.1).length;
  const buyCountMedium = buys.filter(b => b.amountSol >= 0.1 && b.amountSol < 1.0).length;
  const buyCountLarge = buys.filter(b => b.amountSol >= 1.0).length;

  // Breadth score: prefer many small/medium vs few large
  const totalBuys = buys.length || 1;
  const breadthScore = (buyCountSmall + buyCountMedium) / totalBuys;

  // Price velocity (simplified: SOL volume trend as proxy)
  const halfWindow = now - EVENT_WINDOW_MS / 2;
  const firstHalfVolume = buys.filter(b => b.timestamp < halfWindow).reduce((s, b) => s + b.amountSol, 0);
  const secondHalfVolume = buys.filter(b => b.timestamp >= halfWindow).reduce((s, b) => s + b.amountSol, 0);
  const priceVelocity = firstHalfVolume > 0 ? (secondHalfVolume - firstHalfVolume) / firstHalfVolume : 0;

  // Volume acceleration
  const volumeAcceleration = secondHalfVolume > firstHalfVolume ? 1 : -1;

  // Drawdown from high (simplified)
  const drawdownFromHigh = 0; // Would need price history

  return {
    uniqueBuyersPerMin,
    netBuyPressure,
    buyCountSmall,
    buyCountMedium,
    buyCountLarge,
    breadthScore,
    priceVelocity,
    volumeAcceleration,
    drawdownFromHigh,
    timeSinceLaunchSec: (now - tokenInfo.createdAt) / 1000,
    timeSinceGraduationSec: tokenInfo.graduatedAt
      ? (now - tokenInfo.graduatedAt) / 1000
      : null,
  };
}

// ============================================================================
// CONCENTRATION FEATURES
// ============================================================================

export function computeConcentrationFeatures(
  tokenMint: string,
  tokenInfo: TokenInfo
): ConcentrationFeatures {
  // In production, would query holder data from RPC / Helius / DAS API
  // For now, use heuristic from event data
  const events = tokenEvents.get(tokenMint) || [];
  const buys = events.filter(e => e.type === 'BUY');

  // Estimate holder concentration from buy distribution
  const walletVolumes = new Map<string, number>();
  for (const buy of buys) {
    walletVolumes.set(buy.wallet, (walletVolumes.get(buy.wallet) || 0) + buy.amountSol);
  }

  const sortedWallets = [...walletVolumes.entries()].sort((a, b) => b[1] - a[1]);
  const totalVolume = [...walletVolumes.values()].reduce((s, v) => s + v, 0) || 1;

  const top10Volume = sortedWallets.slice(0, 10).reduce((s, [, v]) => s + v, 0);
  const top20Volume = sortedWallets.slice(0, 20).reduce((s, [, v]) => s + v, 0);
  const top10HolderPct = (top10Volume / totalVolume) * 100;
  const top20HolderPct = (top20Volume / totalVolume) * 100;

  // Creator behavior
  const creatorBuys = buys.filter(b => b.wallet === tokenInfo.creator);
  const creatorSells = events.filter(e => e.type === 'SELL' && e.wallet === tokenInfo.creator);
  const creatorBuyVol = creatorBuys.reduce((s, b) => s + b.amountSol, 0);
  const creatorSellVol = creatorSells.reduce((s, b) => s + b.amountSol, 0);
  const creatorSoldPct = creatorBuyVol > 0 ? (creatorSellVol / creatorBuyVol) * 100 : 0;
  const creatorHoldingPct = sortedWallets.length > 0
    ? ((walletVolumes.get(tokenInfo.creator) || 0) / totalVolume) * 100
    : 0;

  // Suspicious if creator sold > 50% quickly
  const suspiciousCreator = creatorSoldPct > 50;

  // Token permissions (would need on-chain check in production)
  const mintAuthorityRevoked = true;  // Assume safe default, override with real check
  const freezeAuthorityRevoked = true;

  let concentrationRisk: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
  let reason: string;
  if (top10HolderPct > 80 || suspiciousCreator) {
    concentrationRisk = 'EXTREME';
    reason = suspiciousCreator
      ? `Creator dumped ${creatorSoldPct.toFixed(0)}% of holdings`
      : `Top 10 holders control ${top10HolderPct.toFixed(0)}%`;
  } else if (top10HolderPct > 60) {
    concentrationRisk = 'HIGH';
    reason = `Top 10 holders control ${top10HolderPct.toFixed(0)}%`;
  } else if (top10HolderPct > 40) {
    concentrationRisk = 'MEDIUM';
    reason = `Top 10 holders control ${top10HolderPct.toFixed(0)}%`;
  } else {
    concentrationRisk = 'LOW';
    reason = `Good distribution: top 10 at ${top10HolderPct.toFixed(0)}%`;
  }

  return {
    top10HolderPct,
    top20HolderPct,
    creatorHoldingPct,
    creatorSoldPct,
    suspiciousCreator,
    mintAuthorityRevoked,
    freezeAuthorityRevoked,
    concentrationRisk,
    reason,
  };
}

// ============================================================================
// EXECUTION RISK FEATURES
// ============================================================================

let rpcLatencyHistory: number[] = [];
let recentFailures = 0;
let recentAttempts = 0;

export function recordRpcLatency(ms: number): void {
  rpcLatencyHistory.push(ms);
  if (rpcLatencyHistory.length > 100) rpcLatencyHistory.shift();
}

export function recordTxAttempt(success: boolean): void {
  recentAttempts++;
  if (!success) recentFailures++;
  // Reset counters periodically
  if (recentAttempts > 200) {
    recentAttempts = Math.floor(recentAttempts / 2);
    recentFailures = Math.floor(recentFailures / 2);
  }
}

export function computeExecutionRiskFeatures(
  tokenMint: string,
  orderSizeSol: number
): ExecutionRiskFeatures {
  // Liquidity depth estimation from event data
  const events = tokenEvents.get(tokenMint) || [];
  const recentBuys = events
    .filter(e => e.type === 'BUY' && e.timestamp > Date.now() - 60_000)
    .reduce((s, e) => s + e.amountSol, 0);

  // Estimate liquidity as recent volume * multiplier
  const liquidityDepthSol = Math.max(recentBuys * 5, 1);

  // Spread proxy (wider spread when low liquidity)
  const spreadBps = Math.max(50, Math.min(1000, 5000 / liquidityDepthSol));

  // Slippage estimate based on order size vs liquidity
  const sizeRatio = orderSizeSol / liquidityDepthSol;
  const estimatedSlippageBps = Math.round(sizeRatio * 1000);

  // RPC health
  const avgLatency = rpcLatencyHistory.length > 0
    ? rpcLatencyHistory.reduce((s, l) => s + l, 0) / rpcLatencyHistory.length
    : 200;

  const failureRate = recentAttempts > 0
    ? recentFailures / recentAttempts
    : 0;

  let executionRisk: 'LOW' | 'MEDIUM' | 'HIGH';
  let reason: string;
  if (estimatedSlippageBps > 500 || avgLatency > 2000 || failureRate > 0.2) {
    executionRisk = 'HIGH';
    reason = `High execution risk: ${estimatedSlippageBps}bps slippage, ${avgLatency.toFixed(0)}ms latency, ${(failureRate*100).toFixed(0)}% failure rate`;
  } else if (estimatedSlippageBps > 200 || avgLatency > 1000 || failureRate > 0.1) {
    executionRisk = 'MEDIUM';
    reason = `Moderate execution risk: ${estimatedSlippageBps}bps slippage, ${avgLatency.toFixed(0)}ms latency`;
  } else {
    executionRisk = 'LOW';
    reason = `Good execution conditions: ${estimatedSlippageBps}bps slippage, ${avgLatency.toFixed(0)}ms latency`;
  }

  return {
    liquidityDepthSol,
    spreadBps,
    estimatedSlippageBps,
    rpcLatencyMs: avgLatency,
    recentFailureRate: failureRate,
    executionRisk,
    reason,
  };
}

// ============================================================================
// COMPOSITE FEATURES
// ============================================================================

export function computeAllFeatures(
  tokenMint: string,
  tokenInfo: TokenInfo,
  config: BotConfig,
  orderSizeSol: number
): AllFeatures {
  return {
    regime: computeRegimeFeatures(config),
    traction: computeTractionFeatures(tokenMint, tokenInfo),
    concentration: computeConcentrationFeatures(tokenMint, tokenInfo),
    execution: computeExecutionRiskFeatures(tokenMint, orderSizeSol),
    computedAt: Date.now(),
  };
}

// --- Clear buffers (for testing) ---
export function clearBuffers(): void {
  eventBuffer.length = 0;
  tokenEvents.clear();
  rpcLatencyHistory = [];
  recentFailures = 0;
  recentAttempts = 0;
}
