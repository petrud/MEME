// ============================================================================
// STRATEGY ENGINE - Rule-based, explainable trading decisions
// Every decision is logged with full reasoning trail
// ============================================================================

import { v4 as uuidv4 } from 'uuid';
import type {
  BotConfig, TokenInfo, DecisionCard, FilterCheck, FilterResult,
  ExecutionPlan, RiskImpact, AllFeatures, RiskState, Position
} from '../../shared/types.js';
import { computeAllFeatures } from '../features/engine.js';
import { saveDecision } from '../data/database.js';

// ============================================================================
// FILTER DEFINITIONS - Each filter has a name, check function, and threshold
// ============================================================================

type FilterFn = (features: AllFeatures, config: BotConfig, token: TokenInfo, risk: RiskState) => FilterCheck;

const FILTERS: FilterFn[] = [
  // 1. Regime gate
  (f, c) => ({
    name: 'Regime Gate',
    result: f.regime.regimeScore >= c.regimeScoreThreshold ? 'PASS' : 'FAIL',
    value: f.regime.regimeScore,
    threshold: c.regimeScoreThreshold,
    reason: f.regime.regimeScore >= c.regimeScoreThreshold
      ? `Market is active (score ${f.regime.regimeScore})`
      : `Market too quiet (score ${f.regime.regimeScore}, need ${c.regimeScoreThreshold})`,
  }),

  // 2. Liquidity minimum
  (f, c) => ({
    name: 'Minimum Liquidity',
    result: f.execution.liquidityDepthSol >= c.minLiquidityDepthSol ? 'PASS' : 'FAIL',
    value: f.execution.liquidityDepthSol,
    threshold: c.minLiquidityDepthSol,
    reason: f.execution.liquidityDepthSol >= c.minLiquidityDepthSol
      ? `Liquidity OK (${f.execution.liquidityDepthSol.toFixed(1)} SOL)`
      : `Too illiquid (${f.execution.liquidityDepthSol.toFixed(1)} SOL, need ${c.minLiquidityDepthSol})`,
  }),

  // 3. Concentration check
  (f, c) => ({
    name: 'Holder Concentration',
    result: f.concentration.top10HolderPct <= c.maxTop10HolderPct ? 'PASS' : 'FAIL',
    value: f.concentration.top10HolderPct,
    threshold: c.maxTop10HolderPct,
    reason: f.concentration.top10HolderPct <= c.maxTop10HolderPct
      ? `Holder distribution OK (top 10: ${f.concentration.top10HolderPct.toFixed(0)}%)`
      : `Too concentrated (top 10: ${f.concentration.top10HolderPct.toFixed(0)}%, max ${c.maxTop10HolderPct}%)`,
  }),

  // 4. Creator behavior
  (f) => ({
    name: 'Creator Behavior',
    result: !f.concentration.suspiciousCreator ? 'PASS' : 'FAIL',
    value: f.concentration.suspiciousCreator,
    threshold: false,
    reason: !f.concentration.suspiciousCreator
      ? 'Creator behavior normal'
      : `Suspicious creator: sold ${f.concentration.creatorSoldPct.toFixed(0)}% already`,
  }),

  // 5. Token permissions
  (f) => ({
    name: 'Token Permissions',
    result: f.concentration.mintAuthorityRevoked && f.concentration.freezeAuthorityRevoked ? 'PASS' : 'FAIL',
    value: `mint:${f.concentration.mintAuthorityRevoked}, freeze:${f.concentration.freezeAuthorityRevoked}`,
    threshold: 'both revoked',
    reason: f.concentration.mintAuthorityRevoked && f.concentration.freezeAuthorityRevoked
      ? 'Token permissions safe (mint/freeze revoked)'
      : 'DANGER: Token has active mint or freeze authority',
  }),

  // 6. Buyer breadth
  (f, c) => ({
    name: 'Buyer Breadth',
    result: f.traction.uniqueBuyersPerMin >= c.minUniqueBuyersPerMin ? 'PASS' : 'FAIL',
    value: f.traction.uniqueBuyersPerMin,
    threshold: c.minUniqueBuyersPerMin,
    reason: f.traction.uniqueBuyersPerMin >= c.minUniqueBuyersPerMin
      ? `Good buyer breadth (${f.traction.uniqueBuyersPerMin.toFixed(1)}/min)`
      : `Not enough buyers (${f.traction.uniqueBuyersPerMin.toFixed(1)}/min, need ${c.minUniqueBuyersPerMin})`,
  }),

  // 7. Breadth score (many small vs few large)
  (f, c) => ({
    name: 'Buy Distribution',
    result: f.traction.breadthScore >= c.minBreadthScore ? 'PASS' : 'FAIL',
    value: f.traction.breadthScore,
    threshold: c.minBreadthScore,
    reason: f.traction.breadthScore >= c.minBreadthScore
      ? `Healthy buy distribution (score ${f.traction.breadthScore.toFixed(2)})`
      : `Dominated by large buyers (score ${f.traction.breadthScore.toFixed(2)}, need ${c.minBreadthScore})`,
  }),

  // 8. Execution risk
  (f, c) => ({
    name: 'Execution Risk',
    result: f.execution.estimatedSlippageBps <= c.maxEstimatedSlippageBps ? 'PASS' : 'FAIL',
    value: f.execution.estimatedSlippageBps,
    threshold: c.maxEstimatedSlippageBps,
    reason: f.execution.estimatedSlippageBps <= c.maxEstimatedSlippageBps
      ? `Slippage OK (${f.execution.estimatedSlippageBps}bps)`
      : `Too much slippage (${f.execution.estimatedSlippageBps}bps, max ${c.maxEstimatedSlippageBps}bps)`,
  }),

  // 9. Spread check
  (f, c) => ({
    name: 'Spread',
    result: f.execution.spreadBps <= c.maxSpreadBps ? 'PASS' : 'FAIL',
    value: f.execution.spreadBps,
    threshold: c.maxSpreadBps,
    reason: f.execution.spreadBps <= c.maxSpreadBps
      ? `Spread OK (${f.execution.spreadBps}bps)`
      : `Spread too wide (${f.execution.spreadBps}bps, max ${c.maxSpreadBps}bps)`,
  }),

  // 10. Graduation timing (post-graduation tokens only)
  (f, c, token) => {
    if (!token.graduatedAt) {
      return {
        name: 'Graduation Timing',
        result: c.tradePreGraduation ? 'PASS' : 'FAIL',
        value: 'not graduated',
        threshold: 'graduated',
        reason: c.tradePreGraduation ? 'Pre-graduation trading enabled' : 'Token not yet graduated',
      };
    }
    const secSinceGrad = f.traction.timeSinceGraduationSec || 0;
    const inWindow = secSinceGrad >= c.minSecondsAfterGraduation && secSinceGrad <= c.maxSecondsAfterGraduation;
    return {
      name: 'Graduation Timing',
      result: inWindow ? 'PASS' : 'FAIL',
      value: secSinceGrad,
      threshold: `${c.minSecondsAfterGraduation}-${c.maxSecondsAfterGraduation}s`,
      reason: inWindow
        ? `Good timing (${secSinceGrad.toFixed(0)}s post-graduation)`
        : secSinceGrad < c.minSecondsAfterGraduation
          ? `Too early (${secSinceGrad.toFixed(0)}s, wait ${c.minSecondsAfterGraduation}s)`
          : `Too late (${secSinceGrad.toFixed(0)}s, max ${c.maxSecondsAfterGraduation}s)`,
    };
  },

  // 11. Net buy pressure
  (f) => ({
    name: 'Buy Pressure',
    result: f.traction.netBuyPressure > 0 ? 'PASS' : 'FAIL',
    value: f.traction.netBuyPressure,
    threshold: 0,
    reason: f.traction.netBuyPressure > 0
      ? `Net buying (${(f.traction.netBuyPressure * 100).toFixed(0)}% bias)`
      : `Net selling or no pressure (${(f.traction.netBuyPressure * 100).toFixed(0)}% bias)`,
  }),

  // 12. Risk limits
  (f, c, token, risk) => {
    const withinLimits = !risk.isHalted &&
      risk.currentExposurePct < c.maxExposurePct &&
      risk.todayTradeCount < c.maxTradesPerDay &&
      risk.hourTradeCount < c.maxTradesPerHour &&
      risk.consecutiveLosses < c.maxConsecutiveLosses &&
      Math.abs(risk.todayDrawdownPct) < c.dailyMaxDrawdownPct;

    let reason = 'All risk limits OK';
    if (risk.isHalted) reason = `Trading halted: ${risk.haltReason}`;
    else if (risk.currentExposurePct >= c.maxExposurePct) reason = `Max exposure reached (${risk.currentExposurePct.toFixed(2)}%)`;
    else if (risk.todayTradeCount >= c.maxTradesPerDay) reason = `Daily trade limit reached (${risk.todayTradeCount})`;
    else if (risk.hourTradeCount >= c.maxTradesPerHour) reason = `Hourly trade limit reached (${risk.hourTradeCount})`;
    else if (risk.consecutiveLosses >= c.maxConsecutiveLosses) reason = `${risk.consecutiveLosses} consecutive losses`;
    else if (Math.abs(risk.todayDrawdownPct) >= c.dailyMaxDrawdownPct) reason = `Daily drawdown limit hit (${risk.todayDrawdownPct.toFixed(2)}%)`;

    return {
      name: 'Risk Limits',
      result: withinLimits ? 'PASS' : 'FAIL',
      value: reason,
      threshold: 'all limits OK',
      reason,
    };
  },

  // 13. RPC health
  (f) => ({
    name: 'RPC Health',
    result: f.execution.rpcLatencyMs < 2000 && f.execution.recentFailureRate < 0.2 ? 'PASS' : 'FAIL',
    value: `${f.execution.rpcLatencyMs.toFixed(0)}ms, ${(f.execution.recentFailureRate*100).toFixed(0)}% failures`,
    threshold: '<2000ms, <20% failures',
    reason: f.execution.rpcLatencyMs < 2000 && f.execution.recentFailureRate < 0.2
      ? 'RPC connection healthy'
      : `RPC degraded: ${f.execution.rpcLatencyMs.toFixed(0)}ms latency, ${(f.execution.recentFailureRate*100).toFixed(0)}% failures`,
  }),
];

// ============================================================================
// DECISION ENGINE
// ============================================================================

export function evaluateToken(
  token: TokenInfo,
  config: BotConfig,
  riskState: RiskState,
  openPositions: Position[]
): DecisionCard {
  // Calculate order size for feature computation
  const orderSizeSol = (config.riskPerTradePct / 100) * riskState.equitySol;

  // Compute all features
  const features = computeAllFeatures(token.mint, token, config, orderSizeSol);

  // Run all filters
  const filterResults = FILTERS.map(fn => fn(features, config, token, riskState));

  // Check if already in position for this token
  const alreadyInPosition = openPositions.some(p => p.tokenMint === token.mint);
  if (alreadyInPosition) {
    filterResults.push({
      name: 'No Duplicate Position',
      result: 'FAIL',
      value: true,
      threshold: false,
      reason: 'Already have an open position in this token',
    });
  }

  // Verdict: ALL filters must pass
  const allPassed = filterResults.every(f => f.result === 'PASS');
  const verdict = allPassed ? 'TRADE' : 'SKIP';

  // Generate plain-language summary (3 bullets)
  const summaryBullets = generateSummary(verdict, filterResults, features, token);

  // Build execution plan if trading
  let executionPlan: ExecutionPlan | undefined;
  let riskImpact: RiskImpact | undefined;

  if (verdict === 'TRADE') {
    executionPlan = {
      route: token.raydiumPoolAddress ? 'JUPITER' : 'PUMP_BONDING_CURVE',
      inputMint: 'So11111111111111111111111111111111111111112', // wSOL
      outputMint: token.mint,
      amountInSol: orderSizeSol,
      estimatedSlippageBps: features.execution.estimatedSlippageBps,
      estimatedOutputTokens: 0, // Would be filled from quote
      priorityFeeLamports: config.priorityFeeLamports,
      splitOrders: orderSizeSol > 1.0 ? 2 : 1, // Split larger orders
    };

    const maxLoss = orderSizeSol * (config.stopLossPct / 100);
    riskImpact = {
      riskPct: config.riskPerTradePct,
      maxLossSol: maxLoss,
      newExposurePct: riskState.currentExposurePct + (orderSizeSol / riskState.equitySol) * 100,
      withinLimits: true,
      limitDetails: `Risk: ${config.riskPerTradePct}% equity (${orderSizeSol.toFixed(4)} SOL). Max loss if stop triggers: ${maxLoss.toFixed(4)} SOL`,
    };
  }

  const card: DecisionCard = {
    id: uuidv4(),
    tokenMint: token.mint,
    tokenSymbol: token.symbol,
    timestamp: Date.now(),
    verdict,
    summaryBullets,
    filters: filterResults,
    features,
    executionPlan,
    riskImpact,
  };

  // Persist
  saveDecision(card);
  return card;
}

// ============================================================================
// SUMMARY GENERATOR
// ============================================================================

function generateSummary(
  verdict: 'TRADE' | 'SKIP',
  filters: FilterCheck[],
  features: AllFeatures,
  token: TokenInfo
): string[] {
  if (verdict === 'SKIP') {
    const failedFilters = filters.filter(f => f.result === 'FAIL');
    const topReasons = failedFilters.slice(0, 3).map(f => f.reason);
    if (topReasons.length === 0) topReasons.push('No specific reason found');
    return [
      `SKIPPING ${token.symbol}: ${failedFilters.length} filter(s) failed`,
      ...topReasons,
    ].slice(0, 3);
  }

  return [
    `TRADING ${token.symbol}: all ${filters.length} filters passed`,
    `Market is ${features.regime.regime.toLowerCase()} with ${features.traction.uniqueBuyersPerMin.toFixed(1)} buyers/min`,
    `Execution looks clean: ${features.execution.estimatedSlippageBps}bps slippage, ${features.execution.liquidityDepthSol.toFixed(1)} SOL depth`,
  ];
}

// ============================================================================
// POSITION EXIT LOGIC
// ============================================================================

export interface ExitSignal {
  type: 'STOP_LOSS' | 'TAKE_PROFIT' | 'TRAILING_STOP' | 'TIME_STOP';
  sellPct: number;      // 0-100 percentage to sell
  reason: string;
  price: number;
}

export function checkExitConditions(
  position: Position,
  currentPrice: number,
  config: BotConfig
): ExitSignal | null {
  const now = Date.now();
  const pnlPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

  // 1. Hard stop-loss
  if (pnlPct <= -config.stopLossPct) {
    return {
      type: 'STOP_LOSS',
      sellPct: 100,
      reason: `Stop-loss triggered at ${pnlPct.toFixed(1)}% (limit: -${config.stopLossPct}%)`,
      price: currentPrice,
    };
  }

  // 2. Take-profit levels
  for (const level of position.takeProfitLevels) {
    if (!level.triggered && pnlPct >= level.pctGain) {
      return {
        type: 'TAKE_PROFIT',
        sellPct: level.sellPct,
        reason: `Take profit at +${level.pctGain}% (selling ${level.sellPct}%)`,
        price: currentPrice,
      };
    }
  }

  // 3. Trailing stop
  if (currentPrice > position.highWaterMark) {
    // Update high water mark (caller should persist)
  }
  const trailingStopPrice = position.highWaterMark * (1 - config.trailingStopPct / 100);
  if (currentPrice <= trailingStopPrice && pnlPct > 0) {
    return {
      type: 'TRAILING_STOP',
      sellPct: 100,
      reason: `Trailing stop: price ${currentPrice.toFixed(8)} fell below ${trailingStopPrice.toFixed(8)} (${config.trailingStopPct}% from high)`,
      price: currentPrice,
    };
  }

  // 4. Time stop
  const minutesHeld = (now - position.entryTime) / 60_000;
  if (minutesHeld >= config.timeStopMinutes && pnlPct < 10) {
    return {
      type: 'TIME_STOP',
      sellPct: 100,
      reason: `Time stop: held ${minutesHeld.toFixed(0)} min with only ${pnlPct.toFixed(1)}% gain`,
      price: currentPrice,
    };
  }

  return null;
}
