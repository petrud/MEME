// ============================================================================
// DEFAULT CONFIGURATION - Conservative, safe defaults
// Override via config.json or environment variables
// ============================================================================

import type { BotConfig } from '../shared/types.js';

export const DEFAULT_CONFIG: BotConfig = {
  // === MODE (PAPER is always default) ===
  mode: 'PAPER',

  // === RPC ===
  rpcEndpoint: process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com',
  rpcWsEndpoint: process.env.RPC_WS_ENDPOINT || 'wss://api.mainnet-beta.solana.com',
  walletPath: process.env.WALLET_PATH || undefined,

  // === REGIME GATE ===
  regimeScoreThreshold: 40,         // Only trade when market is "warm" (0-100 scale)

  // === CANDIDATE FILTERS (aggressive filtering) ===
  minLiquidityDepthSol: 5,          // Minimum 5 SOL liquidity
  maxTop10HolderPct: 70,            // Reject if top 10 holders own > 70%
  minUniqueBuyersPerMin: 3,         // Need broad participation
  minBreadthScore: 0.3,             // Breadth: ratio of small buyers to large
  maxSpreadBps: 500,                // Max 5% spread
  maxEstimatedSlippageBps: 300,     // Max 3% estimated slippage

  // === ENTRY TIMING ===
  minSecondsAfterGraduation: 30,    // Avoid first 30s after pool creation
  maxSecondsAfterGraduation: 600,   // Don't chase after 10 minutes

  // === RISK PER TRADE ===
  riskPerTradePct: 0.20,            // 0.2% of equity per trade
  maxExposurePct: 1.0,              // Max 1% total exposure
  dailyMaxDrawdownPct: 2.0,         // Kill switch: 2% daily drawdown

  // === TRADE LIMITS ===
  maxTradesPerHour: 3,
  maxTradesPerDay: 10,
  maxConsecutiveLosses: 3,          // Pause after 3 losses in a row

  // === EXIT STRATEGY (heavy-tail aware) ===
  stopLossPct: 25,                  // Hard stop at -25%
  takeProfitLevels: [
    { pctGain: 50, sellPct: 30 },   // Sell 30% at +50%
    { pctGain: 100, sellPct: 30 },  // Sell 30% at +100%
    // Remaining 40% rides with trailing stop
  ],
  trailingStopPct: 15,              // 15% trailing stop on remainder
  timeStopMinutes: 60,              // Exit if momentum dies for 60 min

  // === EXECUTION (DEFENSIVE) ===
  maxSlippageBps: 300,              // 3% max slippage tolerance
  priorityFeeLamports: 10_000,      // ~0.00001 SOL priority fee
  maxRetries: 2,                    // Max retry budget
  computeBudget: 200_000,           // Compute unit budget

  // === PAPER TRADING (realistic simulation) ===
  paperStartingEquity: 10,          // 10 SOL starting balance
  paperSlippageMultiplier: 1.5,     // Simulate 1.5x worse slippage
  paperFailureRate: 0.05,           // 5% simulated tx failure
  paperLatencyMs: 500,              // 500ms simulated latency

  // === TRADING SCOPE ===
  tradePreGraduation: false,        // Only trade post-graduation (safer)
  tradePostGraduation: true,
};

/**
 * Load config from file + env vars, merged over defaults.
 * Environment variables override config file values.
 */
export function loadConfig(overrides?: Partial<BotConfig>): BotConfig {
  const config = { ...DEFAULT_CONFIG, ...overrides };

  // Env var overrides (type-safe)
  const envMappings: [string, keyof BotConfig, 'number' | 'string' | 'boolean'][] = [
    ['TRADING_MODE', 'mode', 'string'],
    ['RPC_ENDPOINT', 'rpcEndpoint', 'string'],
    ['RPC_WS_ENDPOINT', 'rpcWsEndpoint', 'string'],
    ['WALLET_PATH', 'walletPath', 'string'],
    ['REGIME_THRESHOLD', 'regimeScoreThreshold', 'number'],
    ['RISK_PER_TRADE_PCT', 'riskPerTradePct', 'number'],
    ['MAX_EXPOSURE_PCT', 'maxExposurePct', 'number'],
    ['DAILY_MAX_DRAWDOWN_PCT', 'dailyMaxDrawdownPct', 'number'],
    ['STOP_LOSS_PCT', 'stopLossPct', 'number'],
    ['TRAILING_STOP_PCT', 'trailingStopPct', 'number'],
    ['MAX_TRADES_PER_HOUR', 'maxTradesPerHour', 'number'],
    ['MAX_TRADES_PER_DAY', 'maxTradesPerDay', 'number'],
    ['PAPER_STARTING_EQUITY', 'paperStartingEquity', 'number'],
  ];

  for (const [envKey, configKey, type] of envMappings) {
    const val = process.env[envKey];
    if (val !== undefined) {
      if (type === 'number') (config as any)[configKey] = parseFloat(val);
      else if (type === 'boolean') (config as any)[configKey] = val === 'true';
      else (config as any)[configKey] = val;
    }
  }

  return config;
}

/**
 * Validate config for safety. Returns list of issues.
 */
export function validateConfig(config: BotConfig): string[] {
  const issues: string[] = [];

  if (config.riskPerTradePct > 1.0) issues.push('Risk per trade > 1% is extremely aggressive');
  if (config.maxExposurePct > 5.0) issues.push('Max exposure > 5% is extremely aggressive');
  if (config.dailyMaxDrawdownPct > 5.0) issues.push('Daily drawdown limit > 5% is very high');
  if (config.stopLossPct > 50) issues.push('Stop loss > 50% is very wide');
  if (config.maxTradesPerDay > 50) issues.push('More than 50 trades/day is excessive');
  if (config.paperFailureRate > 0.5) issues.push('Paper failure rate > 50% is unrealistic');
  if (config.maxSlippageBps > 1000) issues.push('Max slippage > 10% is dangerous');

  if (config.mode === 'LIVE' && !config.walletPath) {
    issues.push('LIVE mode requires a wallet path');
  }

  return issues;
}
