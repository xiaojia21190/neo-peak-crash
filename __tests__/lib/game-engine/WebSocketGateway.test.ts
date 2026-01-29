import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { WebSocketGateway } from '../../../lib/game-engine/WebSocketGateway';
import { WS_EVENTS } from '../../../lib/game-engine/constants';

class FakeGameEngine extends EventEmitter {
  state: any;

  constructor(state: any) {
    super();
    this.state = state;
  }

  getState() {
    return this.state;
  }

  getConfig() {
    return {};
  }

  async placeBet() {
    return;
  }

  async stop() {
    return;
  }
}

class FakePriceService extends EventEmitter {
  async start() {
    return;
  }

  async stop() {
    return;
  }
}

test('WebSocketGateway price handler is safe when gameEngine becomes null', async () => {
  const httpServer = createServer();
  const gameEngine = new FakeGameEngine({ currentRow: 3.25 });
  const priceService = new FakePriceService();

  const gateway = new WebSocketGateway(httpServer as any, {} as any, {} as any, {
    cors: { origin: '*' },
    deps: {
      gameEngine: gameEngine as any,
      priceService: priceService as any,
      verifyToken: async () => null,
      verifyTokenFromCookie: async () => null,
    },
  });

  const emitted: Array<{ event: string; data: any }> = [];
  (gateway as any).io.emit = (event: string, data: any) => {
    emitted.push({ event, data });
    return true as any;
  };

  (gateway as any).setupGameEngineListeners();
  (gateway as any).gameEngine = null;

  assert.doesNotThrow(() => {
    priceService.emit('price', { price: 101, timestamp: 1234 });
  });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]?.event, WS_EVENTS.PRICE_UPDATE);
  assert.equal(emitted[0]?.data?.payload?.rowIndex, 6.5);

  await gateway.stop();
  httpServer.close();
});

