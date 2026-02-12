// ============================================================================
// RISK GOVERNOR - Hard limits, kill switches, portfolio risk management
// ============================================================================

import { v4 as uuidv4 } from 'uuid';
import type { BotConfig, RiskState, RiskLimits, Incident } from '../../shared/types.js';
import {
  getOpenPositions, getTodayTradeCount, getHourTradeCount,
  getConsecutiveLosses, saveIncident
} from '../data/database.js';

let riskState: RiskState = {
  equitySol: 10, startOfDayEquity: 10, todayPnlSol: 0, todayPnlPct: 0,
  todayDrawdownPct: 0, currentExposureSol: 0, currentExposurePct: 0,
  openPositionCount: 0, todayTradeCount: 0, hourTradeCount: 0,
  consecutiveLosses: 0, isHalted: false,
  limits: {
    maxRiskPerTradePct: 0.2, maxExposurePct: 1.0, dailyMaxDrawdownPct: 2.0,
    maxTradesPerHour: 3, maxTradesPerDay: 10, maxConsecutiveLosses: 3,
    stopLossPct: 25, takeProfitLevels: [
      { pctGain: 50, sellPct: 30, triggered: false },
      { pctGain: 100, sellPct: 30, triggered: false },
    ],
    trailingStopPct: 15, timeStopMinutes: 60,
  },
};

export function getRiskState(): RiskState { return { ...riskState }; }

export function initRiskState(config: BotConfig): void {
  riskState.equitySol = config.paperStartingEquity;
  riskState.startOfDayEquity = config.paperStartingEquity;
  riskState.limits = {
    maxRiskPerTradePct: config.riskPerTradePct,
    maxExposurePct: config.maxExposurePct,
    dailyMaxDrawdownPct: config.dailyMaxDrawdownPct,
    maxTradesPerHour: config.maxTradesPerHour,
    maxTradesPerDay: config.maxTradesPerDay,
    maxConsecutiveLosses: config.maxConsecutiveLosses,
    stopLossPct: config.stopLossPct,
    takeProfitLevels: config.takeProfitLevels.map(l => ({ ...l, triggered: false })),
    trailingStopPct: config.trailingStopPct,
    timeStopMinutes: config.timeStopMinutes,
  };
}

export function updateEquity(sol: number): void {
  riskState.equitySol = sol;
  riskState.todayPnlSol = sol - riskState.startOfDayEquity;
  riskState.todayPnlPct = (riskState.todayPnlSol / riskState.startOfDayEquity) * 100;
  if (riskState.todayPnlPct < riskState.todayDrawdownPct) {
    riskState.todayDrawdownPct = riskState.todayPnlPct;
  }
}

export function refreshRiskCounters(): void {
  try {
    const positions = getOpenPositions();
    riskState.openPositionCount = positions.length;
    riskState.currentExposureSol = positions.reduce((s, p) => s + p.entryAmountSol, 0);
    riskState.currentExposurePct = riskState.equitySol > 0
      ? (riskState.currentExposureSol / riskState.equitySol) * 100 : 0;
    riskState.todayTradeCount = getTodayTradeCount();
    riskState.hourTradeCount = getHourTradeCount();
    riskState.consecutiveLosses = getConsecutiveLosses();
  } catch { /* DB not ready yet */ }
}

export interface RiskCheckResult {
  allowed: boolean;
  reason: string;
  details: { check: string; passed: boolean; value: string; limit: string }[];
}

export function checkPreTradeRisk(tradeSizeSol: number, config: BotConfig): RiskCheckResult {
  refreshRiskCounters();
  const details: RiskCheckResult['details'] = [];

  const checks: [string, boolean, string, string][] = [
    ['Not halted', !riskState.isHalted,
      riskState.isHalted ? `Halted: ${riskState.haltReason}` : 'Active', 'Active'],
    ['Daily drawdown', Math.abs(riskState.todayDrawdownPct) < config.dailyMaxDrawdownPct,
      `${riskState.todayDrawdownPct.toFixed(2)}%`, `${config.dailyMaxDrawdownPct}%`],
    ['Exposure limit', ((riskState.currentExposureSol + tradeSizeSol) / riskState.equitySol) * 100 <= config.maxExposurePct,
      `${(((riskState.currentExposureSol + tradeSizeSol) / riskState.equitySol) * 100).toFixed(2)}%`, `${config.maxExposurePct}%`],
    ['Trade size', (tradeSizeSol / riskState.equitySol) * 100 <= config.riskPerTradePct,
      `${((tradeSizeSol / riskState.equitySol) * 100).toFixed(3)}%`, `${config.riskPerTradePct}%`],
    ['Hourly trades', riskState.hourTradeCount < config.maxTradesPerHour,
      `${riskState.hourTradeCount}`, `${config.maxTradesPerHour}`],
    ['Daily trades', riskState.todayTradeCount < config.maxTradesPerDay,
      `${riskState.todayTradeCount}`, `${config.maxTradesPerDay}`],
    ['Consec. losses', riskState.consecutiveLosses < config.maxConsecutiveLosses,
      `${riskState.consecutiveLosses}`, `${config.maxConsecutiveLosses}`],
  ];

  for (const [name, passed, value, limit] of checks) {
    details.push({ check: name, passed, value, limit });
  }

  const allPassed = details.every(d => d.passed);
  const failed = details.filter(d => !d.passed);
  return {
    allowed: allPassed,
    reason: allPassed ? 'All risk checks passed' : `Blocked: ${failed.map(c => c.check).join(', ')}`,
    details,
  };
}

export function activateKillSwitch(reason: string): void {
  riskState.isHalted = true;
  riskState.haltReason = reason;
  riskState.haltedAt = Date.now();
  saveIncident({
    id: uuidv4(), timestamp: Date.now(), severity: 'CRITICAL',
    category: 'KILL_SWITCH', message: `Kill switch: ${reason}`,
    autoAction: 'All new orders blocked', resolved: false,
  });
}

export function deactivateKillSwitch(): void {
  riskState.isHalted = false;
  riskState.haltReason = undefined;
  riskState.haltedAt = undefined;
}

export function runAutoHaltChecks(config: BotConfig): Incident[] {
  refreshRiskCounters();
  const incidents: Incident[] = [];

  if (Math.abs(riskState.todayDrawdownPct) >= config.dailyMaxDrawdownPct && !riskState.isHalted) {
    const msg = `Daily drawdown: ${riskState.todayDrawdownPct.toFixed(2)}% (limit: ${config.dailyMaxDrawdownPct}%)`;
    activateKillSwitch(msg);
    riskState.resumeAt = Date.now() + 24 * 3600_000;
    incidents.push({
      id: uuidv4(), timestamp: Date.now(), severity: 'CRITICAL',
      category: 'DAILY_DRAWDOWN', message: msg,
      autoAction: 'Trading halted for 24h', resolved: false,
    });
  }

  if (riskState.consecutiveLosses >= config.maxConsecutiveLosses && !riskState.isHalted) {
    const msg = `${riskState.consecutiveLosses} consecutive losses`;
    activateKillSwitch(msg);
    incidents.push({
      id: uuidv4(), timestamp: Date.now(), severity: 'WARNING',
      category: 'CONSECUTIVE_LOSSES', message: msg,
      autoAction: 'Trading paused', resolved: false,
    });
  }

  return incidents;
}

export function resetDailyCounters(): void {
  riskState.startOfDayEquity = riskState.equitySol;
  riskState.todayPnlSol = 0;
  riskState.todayPnlPct = 0;
  riskState.todayDrawdownPct = 0;
  riskState.todayTradeCount = 0;
  if (riskState.resumeAt && Date.now() >= riskState.resumeAt) {
    deactivateKillSwitch();
  }
}
