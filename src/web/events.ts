import type { WebSocket } from 'ws';
import type { WebDatabase } from './storage/database.js';
import type { RuntimeEvent } from './types.js';

export class EventHub {
  private readonly clients = new Set<WebSocket>();

  constructor(private readonly database: WebDatabase) {}

  addClient(client: WebSocket): void {
    this.clients.add(client);
    client.once('close', () => this.clients.delete(client));
  }

  publish(input: Omit<RuntimeEvent, 'seq' | 'eventId' | 'createdAt'>): RuntimeEvent {
    const event = this.database.appendEvent(input);
    this.broadcast(event);
    return event;
  }

  broadcast(event: RuntimeEvent): void {
    const body = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) client.send(body);
    }
  }
}
