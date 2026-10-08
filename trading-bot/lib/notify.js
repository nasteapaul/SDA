// Optional Telegram messages for the events that matter (trades, halts, errors that stop
// the bot). Without TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID it does nothing.
const IMPORTANT = /^(Deschis|Închis|Pierderea|Nu știu|Eroare de autentificare|Pornit|Program încheiat|Nu pot porni)/;

export function telegramNotifier({ token, chatId, fetchImpl = fetch } = {}) {
  if (!token || !chatId) return null;
  return async (message) => {
    if (!IMPORTANT.test(message)) return;
    try {
      await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: `🤖 DAX demo: ${message}`.slice(0, 4000) }),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      // A missed notification must never stop trading logic.
    }
  };
}
