// Minimal RFC 6455 WebSocket server side (text frames, ping/pong, close). No dependencies.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 256 * 1024;

export function upgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const conn = new WsConnection(socket);
  if (head && head.length) setImmediate(() => conn.onData(head));
  return conn;
}

class WsConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = null;
    this.closed = false;
    this.alive = true;
    socket.setNoDelay(true);
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.emit('close');
  }

  onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (!this.closed) {
      const buf = this.buffer;
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_PAYLOAD)) return this.close(1009);
        len = Number(big);
        off = 10;
      }
      if (len > MAX_PAYLOAD) return this.close(1009);
      if (!masked) return this.close(1002); // clients must mask
      const maskAt = off;
      off += 4;
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= buf[maskAt + (i & 3)];
      this.buffer = buf.subarray(off + len);
      this.onFrame(fin, op, payload);
    }
  }

  onFrame(fin, op, payload) {
    this.alive = true;
    if (op === 0x8) return this.close(1000);
    if (op === 0x9) return this.sendFrame(0xa, payload);
    if (op === 0xa) return;
    if (op === 0x1 || op === 0x2) {
      if (fin) return this.emit('message', payload.toString('utf8'));
      this.fragments = [payload];
      return;
    }
    if (op === 0x0 && this.fragments) {
      this.fragments.push(payload);
      const total = this.fragments.reduce((s, b) => s + b.length, 0);
      if (total > MAX_PAYLOAD) return this.close(1009);
      if (fin) {
        const msg = Buffer.concat(this.fragments).toString('utf8');
        this.fragments = null;
        this.emit('message', msg);
      }
      return;
    }
    this.close(1002);
  }

  sendFrame(op, payload) {
    if (this.closed) return;
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | op, len]);
    else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | op;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | op;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  send(text) {
    this.sendFrame(0x1, Buffer.from(text, 'utf8'));
  }

  ping() {
    this.sendFrame(0x9, Buffer.alloc(0));
  }

  close(code = 1000) {
    if (this.closed) return;
    const body = Buffer.alloc(2);
    body.writeUInt16BE(code, 0);
    this.sendFrame(0x8, body);
    this.socket.end();
    this.finish();
  }
}
