// Exchange-local time helpers. DAX trades on Frankfurt time (Europe/Berlin, with DST).

const offsetCache = new Map();

// Minutes to add to UTC to get Frankfurt local time, for the UTC calendar day of `time`.
export function berlinOffsetMin(time) {
  const key = Math.floor(time / 864e5);
  let off = offsetCache.get(key);
  if (off === undefined) {
    // Noon UTC avoids the 01:00 UTC switch moment on DST Sundays.
    const noon = key * 864e5 + 12 * 36e5;
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hourCycle: 'h23' }).formatToParts(noon);
    off = (Number(parts.find((p) => p.type === 'hour').value) - 12) * 60;
    offsetCache.set(key, off);
  }
  return off;
}

// { day: 'YYYY-MM-DD', mod: minute of day 0..1439, dow: 0=Sunday } in Frankfurt time.
export function berlinClock(time) {
  const local = time + berlinOffsetMin(time) * 6e4;
  const d = new Date(local);
  return {
    day: d.toISOString().slice(0, 10),
    mod: d.getUTCHours() * 60 + d.getUTCMinutes(),
    dow: d.getUTCDay(),
  };
}

// '09:15' -> 555
export function hhmm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s));
  if (!m || +m[1] > 23 || +m[2] > 59) throw new Error(`Invalid time "${s}", expected HH:MM`);
  return +m[1] * 60 + +m[2];
}
