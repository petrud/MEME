// ============================================================================
// DATA INGESTION - Solana websocket subscription for Pump.fun events
// Detects: new token creation, bonding curve activity, graduation, Raydium pools
// ============================================================================

import { EventEmitter } from 'events';
import type { TokenInfo, BotConfig } from '../../shared/types.js';
import { upsertToken, getToken } from '../data/database.js';
import { recordEvent, recordRpcLatency } from '../features/engine.js';

// Pump.fun program ID (mainnet)
const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const RAYDIUM_AMM_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

export class DataIngestionService extends EventEmitter {
  private config: BotConfig;
  private ws: any = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connected = false;
  private lastSlot = 0;
  private eventCount = 0;

  constructor(config: BotConfig) {
    super();
    this.config = config;
  }

  async start(): Promise<void> {
    console.log('[INGEST] Starting data ingestion...');
    this.connect();
    // Start health monitor
    setInterval(() => this.checkHealth(), 30_000);
  }

  private connect(): void {
    try {
      // In production, use WebSocket to subscribe to Solana logs
      // For now, we simulate the connection and emit synthetic events
      console.log(`[INGEST] Connecting to ${this.config.rpcWsEndpoint}...`);

      // Simulated connection for demo/paper mode
      this.connected = true;
      this.emit('connected');
      console.log('[INGEST] Connected (simulation mode)');

      // Start synthetic event generation for paper trading
      if (this.config.mode === 'PAPER') {
        this.startSyntheticEvents();
      }
    } catch (err) {
      console.error('[INGEST] Connection failed:', err);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 5000);
  }

  /**
   * Generate synthetic events for paper trading demonstration.
   * In production, these would come from Solana websocket logs.
   */
  private startSyntheticEvents(): void {
    const generateToken = (): TokenInfo => {
      const names = [
        'DOGE2', 'MOONCAT', 'SHIBX', 'PEPEMOON', 'BONKINU',
        'WIFHAT', 'CATGOLD', 'SOLDOG', 'POPCAT2', 'FROGKING',
        'MOONDOGE', 'CATWIF', 'SOLAPE', 'PUMPDOG', 'MEMESOL',
      ];
      const name = names[Math.floor(Math.random() * names.length)] + Math.floor(Math.random() * 100);
      const mint = `${name.toLowerCase()}${Date.now().toString(36)}mint`;

      return {
        mint,
        name,
        symbol: name.slice(0, 6).toUpperCase(),
        creator: `creator${Math.random().toString(36).slice(2, 10)}`,
        createdAt: Date.now(),
        phase: 'BONDING_CURVE',
      };
    };

    // Emit new tokens periodically
    const tokenInterval = setInterval(() => {
      if (!this.connected) return;

      const token = generateToken();
      upsertToken(token);

      recordEvent({
        type: 'LAUNCH',
        tokenMint: token.mint,
        wallet: token.creator,
        amountSol: 0,
        timestamp: Date.now(),
      });

      this.emit('newToken', token);
      this.eventCount++;

      // Simulate buys on this token
      const buyCount = Math.floor(Math.random() * 15) + 1;
      for (let i = 0; i < buyCount; i++) {
        setTimeout(() => {
          const amountSol = Math.random() < 0.7
            ? 0.01 + Math.random() * 0.09  // Small buy
            : Math.random() < 0.8
              ? 0.1 + Math.random() * 0.9   // Medium buy
              : 1.0 + Math.random() * 5.0;  // Large buy

          recordEvent({
            type: 'BUY',
            tokenMint: token.mint,
            wallet: `buyer${Math.random().toString(36).slice(2, 10)}`,
            amountSol,
            timestamp: Date.now(),
          });

          this.emit('tokenActivity', { mint: token.mint, type: 'BUY', amountSol });
        }, Math.random() * 30_000);
      }

      // 20% chance of graduation
      if (Math.random() < 0.2) {
        setTimeout(() => {
          token.phase = 'GRADUATED';
          token.graduatedAt = Date.now();
          token.raydiumPoolAddress = `pool${Math.random().toString(36).slice(2, 10)}`;
          upsertToken(token);

          recordEvent({
            type: 'GRADUATION',
            tokenMint: token.mint,
            wallet: token.creator,
            amountSol: 0,
            timestamp: Date.now(),
          });

          this.emit('graduation', token);
          this.eventCount++;
        }, 5000 + Math.random() * 60_000);
      }
    }, 3000 + Math.random() * 7000); // New token every 3-10 seconds

    // Simulate some sells
    const sellInterval = setInterval(() => {
      // Random sell events
      recordEvent({
        type: 'SELL',
        tokenMint: `random${Date.now()}`,
        wallet: `seller${Math.random().toString(36).slice(2, 10)}`,
        amountSol: 0.05 + Math.random() * 2,
        timestamp: Date.now(),
      });
    }, 5000);

    // Simulate RPC latency
    setInterval(() => {
      recordRpcLatency(100 + Math.random() * 400);
    }, 2000);

    // Cleanup on stop
    this.on('stop', () => {
      clearInterval(tokenInterval);
      clearInterval(sellInterval);
    });
  }

  private checkHealth(): void {
    const health = {
      connected: this.connected,
      lastSlot: this.lastSlot,
      eventCount: this.eventCount,
      uptime: process.uptime(),
    };
    this.emit('health', health);
  }

  isConnected(): boolean { return this.connected; }
  getEventCount(): number { return this.eventCount; }

  stop(): void {
    this.connected = false;
    this.emit('stop');
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }
}
