// ============================================================================
// API SERVER - Express HTTP + WebSocket for cockpit UI communication
// ============================================================================

import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import type { BotConfig, WsMessage, TradingMode, BotState } from '../../shared/types.js';
import {
  getRecentTokens, getRecentDecisions, getRecentOrders,
  getOpenPositions, getAllPositions, getRecentIncidents,
  getEquityHistory, saveEquitySnapshot
} from '../data/database.js';
import {
  getRiskState, activateKillSwitch, deactivateKillSwitch,
  initRiskState, refreshRiskCounters
} from '../strategy/risk-governor.js';
import { computeRegimeFeatures } from '../features/engine.js';
import { computePaperStats } from '../paper/engine.js';

export class ApiServer {
  private app: express.Application;
  private server: http.Server;
  private wss: WebSocketServer;
  private config: BotConfig;
  private botState: BotState = 'RUNNING';
  private clients: Set<WebSocket> = new Set();
  private startTime = Date.now();

  constructor(config: BotConfig) {
    this.config = config;
    this.app = express();
    this.app.use(cors());
    this.app.use(express.json());
    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server, path: '/ws' });
    this.setupRoutes();
    this.setupWebSocket();
  }

  private setupRoutes(): void {
    const api = express.Router();

    // --- System Status ---
    api.get('/status', (req, res) => {
      const risk = getRiskState();
      const regime = computeRegimeFeatures(this.config);
      res.json({
        ok: true,
        data: {
          mode: this.config.mode,
          botState: this.botState,
          uptime: Date.now() - this.startTime,
          regime,
          risk,
          config: this.sanitizeConfig(this.config),
        }
      });
    });

    // --- Tokens ---
    api.get('/tokens', (req, res) => {
      const limit = parseInt(req.query.limit as string) || 50;
      res.json({ ok: true, data: getRecentTokens(limit) });
    });

    // --- Decisions ---
    api.get('/decisions', (req, res) => {
      const limit = parseInt(req.query.limit as string) || 100;
      res.json({ ok: true, data: getRecentDecisions(limit) });
    });

    // --- Orders ---
    api.get('/orders', (req, res) => {
      const limit = parseInt(req.query.limit as string) || 50;
      res.json({ ok: true, data: getRecentOrders(limit) });
    });

    // --- Positions ---
    api.get('/positions', (req, res) => {
      res.json({ ok: true, data: getOpenPositions() });
    });

    api.get('/positions/all', (req, res) => {
      const limit = parseInt(req.query.limit as string) || 100;
      res.json({ ok: true, data: getAllPositions(limit) });
    });

    // --- Risk ---
    api.get('/risk', (req, res) => {
      refreshRiskCounters();
      res.json({ ok: true, data: getRiskState() });
    });

    // --- Kill Switch ---
    api.post('/kill-switch', (req, res) => {
      activateKillSwitch('Manual kill switch activated by operator');
      this.botState = 'HALTED';
      this.broadcast({ type: 'SYSTEM_STATUS', payload: { botState: 'HALTED', mode: this.config.mode }, timestamp: Date.now() });
      res.json({ ok: true, data: { message: 'Kill switch activated. All new orders blocked.' } });
    });

    api.post('/kill-switch/deactivate', (req, res) => {
      deactivateKillSwitch();
      this.botState = 'RUNNING';
      this.broadcast({ type: 'SYSTEM_STATUS', payload: { botState: 'RUNNING', mode: this.config.mode }, timestamp: Date.now() });
      res.json({ ok: true, data: { message: 'Kill switch deactivated. Trading resumed.' } });
    });

    // --- Mode Control ---
    api.post('/mode', (req, res) => {
      const { mode, confirmation } = req.body;
      if (mode === 'LIVE') {
        if (confirmation !== 'TRADE LIVE') {
          return res.status(400).json({
            ok: false,
            error: 'To switch to LIVE mode, send confirmation: "TRADE LIVE"'
          });
        }
        if (!this.config.walletPath) {
          return res.status(400).json({
            ok: false,
            error: 'Cannot switch to LIVE: no wallet configured'
          });
        }
      }
      this.config.mode = mode as TradingMode;
      this.broadcast({ type: 'SYSTEM_STATUS', payload: { mode, botState: this.botState }, timestamp: Date.now() });
      res.json({ ok: true, data: { mode: this.config.mode } });
    });

    // --- Bot State ---
    api.post('/state', (req, res) => {
      const { state } = req.body;
      if (['RUNNING', 'PAUSED'].includes(state)) {
        this.botState = state as BotState;
        this.broadcast({ type: 'SYSTEM_STATUS', payload: { botState: this.botState, mode: this.config.mode }, timestamp: Date.now() });
        res.json({ ok: true, data: { botState: this.botState } });
      } else {
        res.status(400).json({ ok: false, error: 'Invalid state. Use RUNNING or PAUSED.' });
      }
    });

    // --- Incidents ---
    api.get('/incidents', (req, res) => {
      const limit = parseInt(req.query.limit as string) || 50;
      res.json({ ok: true, data: getRecentIncidents(limit) });
    });

    // --- Equity History ---
    api.get('/equity', (req, res) => {
      const since = parseInt(req.query.since as string) || Date.now() - 24 * 3600_000;
      const isPaper = this.config.mode === 'PAPER';
      res.json({ ok: true, data: getEquityHistory(since, isPaper) });
    });

    // --- Paper Stats ---
    api.get('/paper/stats', (req, res) => {
      const positions = getAllPositions(1000);
      const orders = getRecentOrders(1000);
      const stats = computePaperStats(positions, orders);
      res.json({ ok: true, data: stats });
    });

    // --- Health ---
    api.get('/health', (req, res) => {
      res.json({
        ok: true,
        data: {
          uptime: Date.now() - this.startTime,
          wsClients: this.clients.size,
          memoryMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          mode: this.config.mode,
          botState: this.botState,
        }
      });
    });

    // --- Config (read-only, sanitized) ---
    api.get('/config', (req, res) => {
      res.json({ ok: true, data: this.sanitizeConfig(this.config) });
    });

    this.app.use('/api', api);

    // Serve static frontend in production
    this.app.get('/', (req, res) => {
      res.send('Solana Memecoin Cockpit API - connect UI at port 3000');
    });
  }

  private setupWebSocket(): void {
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      console.log(`[WS] Client connected (${this.clients.size} total)`);

      // Send initial state
      const risk = getRiskState();
      const regime = computeRegimeFeatures(this.config);
      ws.send(JSON.stringify({
        type: 'SYSTEM_STATUS',
        payload: { mode: this.config.mode, botState: this.botState, risk, regime },
        timestamp: Date.now(),
      }));

      ws.on('close', () => {
        this.clients.delete(ws);
        console.log(`[WS] Client disconnected (${this.clients.size} total)`);
      });

      ws.on('error', (err) => {
        console.error('[WS] Client error:', err.message);
        this.clients.delete(ws);
      });
    });
  }

  broadcast(message: WsMessage): void {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(data); } catch {}
      }
    }
  }

  getBotState(): BotState { return this.botState; }
  setBotState(state: BotState): void { this.botState = state; }

  private sanitizeConfig(config: BotConfig): Partial<BotConfig> {
    const { walletPath, ...safe } = config;
    return { ...safe, walletPath: walletPath ? '***configured***' : undefined };
  }

  async start(port: number = 3001): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(port, () => {
        console.log(`[API] Server running on http://localhost:${port}`);
        console.log(`[API] WebSocket at ws://localhost:${port}/ws`);
        resolve();
      });
    });
  }

  stop(): void {
    this.wss.close();
    this.server.close();
  }
}
