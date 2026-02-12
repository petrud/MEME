// ============================================================================
// PAPER TRADING ENGINE - First-class simulation with realistic conditions
// Simulates slippage, partial fills, failures, and latency
// ============================================================================

import { v4 as uuidv4 } from 'uuid';
import type {
  BotConfig, Order, Position, ExecutionPlan, TakeProfitLevel
} from '../../shared/types.js';
import { saveOrder, savePosition, getOpenPositions } from '../data/database.js';
import { updateEquity, getRiskState } from '../strategy/risk-governor.js';

export class PaperTradingEngine {
  private config: BotConfig;

  constructor(config: BotConfig) {
    this.config = config;
  }

  /**
   * Simulate a buy order with realistic conditions
   */
  async executeBuy(plan: ExecutionPlan, decisionCardId: string): Promise<Order> {
    const orderId = uuidv4();
    const idempotencyKey = `paper-buy-${plan.outputMint}-${Date.now()}`;

    // Simulate latency
    await this.simulateLatency();

    // Simulate failure
    if (Math.random() < this.config.paperFailureRate) {
      const order: Order = {
        id: orderId, idempotencyKey, tokenMint: plan.outputMint,
        tokenSymbol: plan.outputMint.slice(0, 6), side: 'BUY', source: 'ENTRY_SIGNAL',
        amountSol: plan.amountInSol, amountTokens: 0,
        estimatedPrice: 0, status: 'FAILED', isPaper: true,
        decisionCardId, createdAt: Date.now(), updatedAt: Date.now(),
        retryCount: 0, errorMessage: 'Simulated transaction failure',
      };
      saveOrder(order);
      return order;
    }

    // Simulate slippage (worse than real by multiplier)
    const baseSlippageBps = plan.estimatedSlippageBps;
    const actualSlippageBps = Math.round(
      baseSlippageBps * this.config.paperSlippageMultiplier * (0.8 + Math.random() * 0.4)
    );

    // Simulate partial fill (90% chance of full fill)
    const fillRatio = Math.random() < 0.9 ? 1.0 : 0.5 + Math.random() * 0.5;

    const actualAmountSol = plan.amountInSol * fillRatio;
    const slippageFactor = 1 + actualSlippageBps / 10000;
    const simulatedPrice = 0.000001 * slippageFactor; // Placeholder price
    const tokensReceived = actualAmountSol / simulatedPrice;
    const feeSol = actualAmountSol * 0.003; // ~0.3% fee simulation

    const order: Order = {
      id: orderId, idempotencyKey, tokenMint: plan.outputMint,
      tokenSymbol: plan.outputMint.slice(0, 6), side: 'BUY', source: 'ENTRY_SIGNAL',
      amountSol: actualAmountSol, amountTokens: tokensReceived,
      estimatedPrice: simulatedPrice, executedPrice: simulatedPrice,
      slippageBps: actualSlippageBps, feeSol,
      status: fillRatio >= 1.0 ? 'CONFIRMED' : 'CONFIRMED',
      txSignature: `paper_${orderId.slice(0, 16)}`,
      isPaper: true, decisionCardId,
      createdAt: Date.now(), updatedAt: Date.now(), retryCount: 0,
    };
    saveOrder(order);

    // Create position
    if (order.status === 'CONFIRMED') {
      const stopLossPrice = simulatedPrice * (1 - this.config.stopLossPct / 100);
      const position: Position = {
        id: uuidv4(), tokenMint: plan.outputMint,
        tokenSymbol: order.tokenSymbol, status: 'OPEN',
        entryPrice: simulatedPrice, currentPrice: simulatedPrice,
        entryAmountSol: actualAmountSol, remainingTokens: tokensReceived,
        totalTokensBought: tokensReceived, totalTokensSold: 0,
        realizedPnlSol: 0, unrealizedPnlSol: 0, unrealizedPnlPct: 0,
        stopLossPrice,
        takeProfitLevels: this.config.takeProfitLevels.map(l => ({
          ...l, triggered: false,
        })),
        trailingStopPct: this.config.trailingStopPct,
        trailingStopPrice: stopLossPrice,
        highWaterMark: simulatedPrice,
        timeStopMinutes: this.config.timeStopMinutes,
        entryTime: Date.now(), lastUpdateTime: Date.now(),
        isPaper: true, decisionCardId,
      };
      savePosition(position);

      // Update equity
      const risk = getRiskState();
      updateEquity(risk.equitySol - actualAmountSol - feeSol);
    }

    return order;
  }

  /**
   * Simulate a sell order
   */
  async executeSell(
    position: Position,
    sellPct: number,
    source: Order['source'],
    currentPrice: number
  ): Promise<Order> {
    const orderId = uuidv4();
    const idempotencyKey = `paper-sell-${position.tokenMint}-${Date.now()}`;

    await this.simulateLatency();

    if (Math.random() < this.config.paperFailureRate * 0.5) { // Less failure on sells
      const order: Order = {
        id: orderId, idempotencyKey, tokenMint: position.tokenMint,
        tokenSymbol: position.tokenSymbol, side: 'SELL', source,
        amountSol: 0, amountTokens: 0, estimatedPrice: currentPrice,
        status: 'FAILED', isPaper: true, decisionCardId: position.decisionCardId,
        createdAt: Date.now(), updatedAt: Date.now(), retryCount: 0,
        errorMessage: 'Simulated sell failure',
      };
      saveOrder(order);
      return order;
    }

    const tokensToSell = position.remainingTokens * (sellPct / 100);
    const slippageBps = Math.round(50 * this.config.paperSlippageMultiplier * (0.8 + Math.random() * 0.4));
    const executedPrice = currentPrice * (1 - slippageBps / 10000);
    const solReceived = tokensToSell * executedPrice;
    const feeSol = solReceived * 0.003;
    const netSol = solReceived - feeSol;

    const order: Order = {
      id: orderId, idempotencyKey, tokenMint: position.tokenMint,
      tokenSymbol: position.tokenSymbol, side: 'SELL', source,
      amountSol: netSol, amountTokens: tokensToSell,
      estimatedPrice: currentPrice, executedPrice,
      slippageBps, feeSol, status: 'CONFIRMED',
      txSignature: `paper_${orderId.slice(0, 16)}`,
      isPaper: true, decisionCardId: position.decisionCardId,
      createdAt: Date.now(), updatedAt: Date.now(), retryCount: 0,
    };
    saveOrder(order);

    // Update position
    position.remainingTokens -= tokensToSell;
    position.totalTokensSold += tokensToSell;
    position.realizedPnlSol += netSol - (tokensToSell * position.entryPrice);
    position.lastUpdateTime = Date.now();

    if (position.remainingTokens <= 0.01) {
      position.status = 'CLOSED';
      position.remainingTokens = 0;
      position.exitReason = source;
    } else {
      position.status = 'PARTIALLY_CLOSED';
    }
    savePosition(position);

    // Update equity
    const risk = getRiskState();
    updateEquity(risk.equitySol + netSol);

    return order;
  }

  private async simulateLatency(): Promise<void> {
    const jitter = this.config.paperLatencyMs * (0.5 + Math.random());
    await new Promise(resolve => setTimeout(resolve, jitter));
  }
}

// ============================================================================
// PAPER TRADING STATISTICS
// ============================================================================

export interface PaperStats {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnlSol: number;
  avgPnlPerTrade: number;
  maxDrawdownPct: number;
  avgSlippageBps: number;
  avgHoldTimeMinutes: number;
  expectancy: number;
  sharpeProxy: number;
  filterHitRates: Record<string, number>;
  regimeOnTimePct: number;
}

export function computePaperStats(
  positions: Position[],
  orders: Order[],
): PaperStats {
  const closedPositions = positions.filter(p => p.status === 'CLOSED');
  const wins = closedPositions.filter(p => p.realizedPnlSol > 0);
  const losses = closedPositions.filter(p => p.realizedPnlSol <= 0);

  const totalPnl = closedPositions.reduce((s, p) => s + p.realizedPnlSol, 0);
  const avgPnl = closedPositions.length > 0 ? totalPnl / closedPositions.length : 0;

  const holdTimes = closedPositions.map(p => (p.lastUpdateTime - p.entryTime) / 60_000);
  const avgHoldTime = holdTimes.length > 0 ? holdTimes.reduce((s, t) => s + t, 0) / holdTimes.length : 0;

  const slippages = orders.filter(o => o.slippageBps != null).map(o => o.slippageBps!);
  const avgSlippage = slippages.length > 0 ? slippages.reduce((s, v) => s + v, 0) / slippages.length : 0;

  const winRate = closedPositions.length > 0 ? wins.length / closedPositions.length : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, p) => s + p.realizedPnlSol, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, p) => s + p.realizedPnlSol, 0) / losses.length) : 0;
  const expectancy = winRate * avgWin - (1 - winRate) * avgLoss;

  return {
    totalTrades: closedPositions.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRate,
    totalPnlSol: totalPnl,
    avgPnlPerTrade: avgPnl,
    maxDrawdownPct: 0, // Would compute from equity history
    avgSlippageBps: avgSlippage,
    avgHoldTimeMinutes: avgHoldTime,
    expectancy,
    sharpeProxy: 0,
    filterHitRates: {},
    regimeOnTimePct: 0,
  };
}
