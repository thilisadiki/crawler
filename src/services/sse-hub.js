// Keeps transport connections separate from crawler and HTTP-route state.
export class SseHub {
  constructor() {
    this.clients = new Set();
  }

  add(sessionId, res) {
    const client = { sessionId, res };
    this.clients.add(client);
    return client;
  }

  remove(client) {
    this.clients.delete(client);
  }

  send(client, eventType, data) {
    try {
      client.res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      this.clients.delete(client);
      return false;
    }
  }

  broadcast(sessionId, eventType, data) {
    for (const client of this.clients) {
      if (client.sessionId === sessionId) this.send(client, eventType, data);
    }
  }

  broadcastAll(eventType, data) {
    for (const client of this.clients) this.send(client, eventType, data);
  }

  closeSession(sessionId, eventType, data) {
    for (const client of [...this.clients]) {
      if (client.sessionId !== sessionId) continue;
      this.send(client, eventType, data);
      try { client.res.end(); } catch {}
      this.clients.delete(client);
    }
  }
}
