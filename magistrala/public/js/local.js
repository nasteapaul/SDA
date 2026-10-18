// Play against the training robot on one phone. Same interface as the online controller.
import * as E from './engine/engine.js';
import { botAction } from './engine/bot.js';

const KEY = 'magistrala.local';

export class BotGame {
  constructor(handlers) {
    this.h = handlers;
    this.timer = null;
  }

  static hasSaved() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || 'null');
      return Boolean(s && !s.over);
    } catch {
      return false;
    }
  }

  start(name) {
    this.options = E.validateOptions({ names: [name || 'Tu', 'Robotul Rareș'] });
    this.actions = [];
    this.state = E.createGame(this.options);
    this.save();
    this.emit([]);
  }

  resume() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || 'null');
      this.options = s.options;
      this.actions = s.actions;
      this.state = E.replay(this.options, this.actions);
      this.emit([]);
      return true;
    } catch {
      return false;
    }
  }

  save() {
    try { localStorage.setItem(KEY, JSON.stringify({ options: this.options, actions: this.actions, over: this.state.phase === 'over' })); } catch { /* ignore */ }
  }

  players() {
    return { A: { name: this.options.names[0], online: true, joined: true }, B: { name: this.options.names[1], online: true, joined: true, bot: true } };
  }

  emit(events) {
    this.h.state?.(E.viewFor(this.state, 0), E.eventsFor(events, 0), this.players());
  }

  apply(p, action) {
    const { state, events } = E.applyAction(this.state, p, action);
    this.state = state;
    this.actions.push([p, action]);
    this.save();
    this.emit(events);
  }

  act(action) {
    try {
      this.apply(0, action);
    } catch (err) {
      this.h.error?.(err.message, false);
    }
  }

  botMustAct() {
    const s = this.state;
    if (s.phase === 'setup') return s.players[1].pending.length > 0;
    if (s.phase === 'auction') return !s.auction.bids[1];
    if (s.phase === 'turn') return s.active === 1 || s.players[1].pending.length > 0 && s.active === 1;
    return false;
  }

  /** The app calls this when the board has finished animating. */
  idle() {
    clearTimeout(this.timer);
    if (!this.state || !this.botMustAct()) return;
    const quick = this.state.phase !== 'turn' || this.state.drawn;
    this.timer = setTimeout(() => {
      if (!this.botMustAct()) return;
      try {
        this.apply(1, botAction(this.state, 1));
      } catch (err) {
        console.error('bot', err);
      }
    }, quick ? 450 : 900);
  }

  rematch() {
    this.start(this.options.names[0]);
  }

  react() {}

  leave() {
    clearTimeout(this.timer);
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  }
}
