// Training mode: the whole game runs on one phone, both roles visible.
import * as E from './engine/engine.js';

const KEY = 'farul.local';

export class LocalGame {
  constructor(handlers) {
    this.h = handlers;
    this.role = 'both';
  }

  start(options) {
    this.options = E.validateOptions(options);
    this.actions = [];
    this.state = E.createGame(this.options);
    this.save();
    this.emit([]);
  }

  resume() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (!saved) return false;
      this.options = saved.options;
      this.actions = saved.actions;
      this.state = E.replay(this.options, this.actions);
      this.emit([]);
      return true;
    } catch {
      return false;
    }
  }

  static hasSaved() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
      return Boolean(saved && !saved.over);
    } catch {
      return false;
    }
  }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ options: this.options, actions: this.actions, over: this.state.phase === 'over' }));
    } catch { /* ignore */ }
  }

  emit(events) {
    this.h.state?.(E.viewFor(this.state, 'both'), events, {
      A: { name: 'Paznicul', online: true, joined: true },
      B: { name: 'Căpitanul', online: true, joined: true },
    });
  }

  act(action) {
    const role = action.type === 'signal' ? (E.activeRole(this.state) || 'A') : E.activeRole(this.state);
    try {
      const { state, events } = E.applyAction(this.state, role, action);
      this.state = state;
      this.actions.push([role, action]);
      this.save();
      this.emit(events);
    } catch (err) {
      this.h.error?.(err.message, false);
    }
  }

  rematch(options) {
    this.start({ ...this.options, ...options, seed: undefined });
  }

  react() {}

  leave() {
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  }
}
