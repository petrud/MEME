// ============================================================================
// MAIN ORCHESTRATOR - Ties together all backend services
// ============================================================================

import dotenv from 'dotenv';
dotenv.config();

import { loadConfig, validateConfig } from '../../config/defaults.js';
import { getDb, saveEquitySnapshot } from './data/database.js';
import { DataIngestionService } from './data/ingestion.js';
import { ApiServer } from './api/server.js';
import { PaperTradingEngine } from './paper/engine.js';
import { evaluateToken, checkExitConditions } from './strategy/engine.js';
import {
  initRiskState, getRiskState, runAutoHaltChecks,
  refreshRiskCounters, resetDailyCounters, checkPreTradeRisk
} from './strategy/risk-governor.js';
import { computeRegimeFeatures } from './features/engine.js';
import { getOpenPositions } from './data/database.js';
import type { TokenInfo, BotConfig } from '../shared/types.js';

class TradingBot {
  private config: BotConfig;
  private ingestion: DataIngestionService;
  private api: ApiServer;
  private paperEngine: PaperTradingEngine;
  private evaluationQueue: TokenInfo[] = [];
  private isProcessing = false;

  constructor() {
    // Load config
    this.config = loadConfig();
    const issues = validateConfig(this.config);
    if (issues.length > 0) {
      console.warn('[BOOT] Config warnings:');
      issues.forEach(i => console.warn(`  ⚠ ${i}`));
    }

    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║   SOLANA MEMECOIN TRADING BOT - COCKPIT ENGINE      ║');
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log(`║  Mode: ${this.config.mode.padEnd(46)}║`);
    console.log(`║  Risk/trade: ${(this.config.riskPerTradePct + '%').padEnd(40)}║`);
    console.log(`║  Max exposure: ${(this.config.maxExposurePct + '%').padEnd(38)}║`);
    console.log(`║  Daily drawdown limit: ${(this.config.dailyMaxDrawdownPct + '%').padEnd(30)}║`);
    console.log('╚══════════════════════════════════════════════════════╝');

    // Initialize database
    getDb();

    // Initialize risk state
    initRiskState(this.config);

    // Create services
    this.ingestion = new DataIngestionService(this.config);
    this.api = new ApiServer(this.config);
    this.paperEngine = new PaperTradingEngine(this.config);
  }

  async start(): Promise<void> {
    console.log('[BOOT] Starting services...');

    // Start API server
    await this.api.start(parseInt(process.env.API_PORT || '3001'));

    // Start data ingestion
    await this.ingestion.start();

    // Wire up event handlers
    this.ingestion.on('graduation', (token: TokenInfo) => {
      if (this.config.tradePostGraduation) {
        this.evaluationQueue.push(token);
        this.processQueue();
      }
      this.api.broadcast({
        type: 'TOKEN_EVENT',
        payload: { event: 'GRADUATION', token },
        timestamp: Date.now(),
      });
    });

    this.ingestion.on('newToken', (token: TokenInfo) => {
      if (this.config.tradePreGraduation) {
        this.evaluationQueue.push(token);
        this.processQueue();
      }
      this.api.broadcast({
        type: 'RADAR_UPDATE',
        payload: { token },
        timestamp: Date.now(),
      });
    });

    // Start periodic tasks
    this.startPeriodicTasks();

    console.log('[BOOT] All services started. Bot is running.');
    console.log(`[BOOT] Open cockpit UI at http://localhost:3000`);
    console.log(`[BOOT] API available at http://localhost:3001/api`);
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (this.evaluationQueue.length > 0) {
        const token = this.evaluationQueue.shift()!;

        // Skip if bot is paused or halted
        if (this.api.getBotState() !== 'RUNNING') continue;

        const openPositions = getOpenPositions();
        const decision = evaluateToken(token, this.config, getRiskState(), openPositions);

        // Broadcast decision
        this.api.broadcast({
          type: 'DECISION_CARD',
          payload: decision,
          timestamp: Date.now(),
        });

        // Execute if TRADE verdict
        if (decision.verdict === 'TRADE' && decision.executionPlan) {
          const riskCheck = checkPreTradeRisk(
            decision.executionPlan.amountInSol, this.config
          );

          if (riskCheck.allowed) {
            if (this.config.mode === 'PAPER') {
              const order = await this.paperEngine.executeBuy(
                decision.executionPlan, decision.id
              );
              this.api.broadcast({
                type: 'ORDER_UPDATE',
                payload: order,
                timestamp: Date.now(),
              });
            }
            // LIVE execution would go here (not implemented for safety)
          }
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private startPeriodicTasks(): void {
    // Position monitoring (check exits every 5s)
    setInterval(async () => {
      if (this.api.getBotState() !== 'RUNNING') return;

      const positions = getOpenPositions();
      for (const pos of positions) {
        // Simulate price movement for paper trading
        const priceChange = 1 + (Math.random() - 0.45) * 0.1; // Slight upward bias
        const currentPrice = pos.currentPrice * priceChange;

        // Update high water mark
        if (currentPrice > pos.highWaterMark) {
          pos.highWaterMark = currentPrice;
        }
        pos.currentPrice = currentPrice;
        pos.unrealizedPnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
        pos.unrealizedPnlSol = pos.remainingTokens * (currentPrice - pos.entryPrice);

        // Check exit conditions
        const exitSignal = checkExitConditions(pos, currentPrice, this.config);
        if (exitSignal && this.config.mode === 'PAPER') {
          const order = await this.paperEngine.executeSell(
            pos, exitSignal.sellPct, exitSignal.type as any, currentPrice
          );
          this.api.broadcast({
            type: 'ORDER_UPDATE', payload: order, timestamp: Date.now(),
          });
          this.api.broadcast({
            type: 'POSITION_UPDATE', payload: pos, timestamp: Date.now(),
          });
        }
      }
    }, 5000);

    // Risk checks (every 10s)
    setInterval(() => {
      const incidents = runAutoHaltChecks(this.config);
      for (const incident of incidents) {
        this.api.broadcast({
          type: 'INCIDENT', payload: incident, timestamp: Date.now(),
        });
      }
    }, 10_000);

    // Equity snapshot (every 30s)
    setInterval(() => {
      const risk = getRiskState();
      saveEquitySnapshot(
        risk.equitySol,
        risk.todayDrawdownPct,
        risk.currentExposurePct,
        this.config.mode === 'PAPER'
      );
      this.api.broadcast({
        type: 'EQUITY_TICK',
        payload: { equity: risk.equitySol, drawdown: risk.todayDrawdownPct, exposure: risk.currentExposurePct },
        timestamp: Date.now(),
      });
    }, 30_000);

    // Regime broadcast (every 15s)
    setInterval(() => {
      const regime = computeRegimeFeatures(this.config);
      this.api.broadcast({
        type: 'REGIME_UPDATE', payload: regime, timestamp: Date.now(),
      });
    }, 15_000);

    // Daily reset (check every minute)
    setInterval(() => {
      const now = new Date();
      if (now.getHours() === 0 && now.getMinutes() === 0) {
        resetDailyCounters();
        console.log('[DAILY] Counters reset');
      }
    }, 60_000);

    // Risk counter refresh (every 5s)
    setInterval(() => {
      refreshRiskCounters();
      this.api.broadcast({
        type: 'RISK_UPDATE', payload: getRiskState(), timestamp: Date.now(),
      });
    }, 5000);
  }
}

// ============================================================================
// BOOT
// ============================================================================

const bot = new TradingBot();
bot.start().catch((err) => {
  console.error('[FATAL] Failed to start:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[SHUTDOWN] Received SIGINT, shutting down gracefully...');
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log('\n[SHUTDOWN] Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});
