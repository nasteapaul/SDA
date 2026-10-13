// Online controller: WebSocket to the Farul server, with reconnect and keep-alive.
const SESSION_KEY = 'farul.session';

export function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
}

export function saveSession(s) {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* ignore */ }
}

export class OnlineGame {
  constructor(handlers) {
    this.h = handlers; // { joined, state, presence, error, react, status }
    this.ws = null;
    this.session = null;
    this.pending = null; // first message to send once connected
    this.closedByUser = false;
    this.retry = 0;
    this.keepAlive = null;
  }

  url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  connect(first) {
    this.pending = first;
    this.closedByUser = false;
    this.open();
  }

  open() {
    clearTimeout(this.reconnectTimer);
    this.h.status?.('connecting');
    let ws;
    try {
      ws = new WebSocket(this.url());
    } catch {
      this.h.error?.('Nu mă pot conecta la server.', false);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.h.status?.('online');
      if (this.session) this.sendRaw({ t: 'rejoin', ...this.sessionPayload() });
      else if (this.pending) this.sendRaw(this.pending);
      clearInterval(this.keepAlive);
      // free hosts sleep without inbound traffic; a tiny ping keeps the room alive
      this.keepAlive = setInterval(() => this.sendRaw({ t: 'ping' }), 20000);
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this.onMessage(msg);
    };
    ws.onclose = () => {
      clearInterval(this.keepAlive);
      if (this.ws !== ws || this.closedByUser) return;
      this.h.status?.('offline');
      const delay = Math.min(10000, 600 * 2 ** this.retry++);
      this.reconnectTimer = setTimeout(() => this.open(), delay);
    };
  }

  sessionPayload() {
    return { code: this.session.code, role: this.session.role, token: this.session.token, replay: this.session.replay, name: this.session.name };
  }

  onMessage(msg) {
    if (msg.t === 'joined') {
      this.session = { ...(this.session || {}), code: msg.code, role: msg.role, token: msg.token, name: this.pending?.name || this.session?.name };
      saveSession(this.session);
      this.h.joined?.(msg);
    } else if (msg.t === 'state') {
      if (this.session) {
        this.session.replay = msg.replay;
        this.session.over = msg.view.phase === 'over';
        saveSession(this.session);
      }
      this.h.state?.(msg.view, msg.events, msg.players);
    } else if (msg.t === 'presence') this.h.presence?.(msg.players);
    else if (msg.t === 'react') this.h.react?.(msg.emoji, msg.from);
    else if (msg.t === 'error') {
      if (msg.fatal) {
        this.session = null;
        saveSession(null);
      }
      this.h.error?.(msg.msg, Boolean(msg.fatal));
    }
  }

  resume(session) {
    this.session = session;
    this.connect(null);
  }

  sendRaw(msg) {
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  act(action) {
    if (!this.sendRaw({ t: 'act', action })) this.h.error?.('Fără conexiune — reîncerc…', false);
  }

  rematch(options) { this.sendRaw({ t: 'rematch', options }); }

  react(emoji) { this.sendRaw({ t: 'react', emoji }); }

  leave() {
    this.closedByUser = true;
    clearInterval(this.keepAlive);
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.session = null;
    saveSession(null);
  }
}
