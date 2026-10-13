// Exchange-local time helpers. DAX trades on Frankfurt time (Europe/Berlin, with DST).

const offsetCache = new Map();

// Minutes to add to UTC to get local time in `tz`, for the UTC calendar day of `time`.
export function tzOffsetMin(time, tz) {
  const key = `${tz}|${Math.floor(time / 864e5)}`;
  let off = offsetCache.get(key);
  if (off === undefined) {
    // Noon UTC avoids the early-morning switch moment on DST Sundays.
    const noon = Math.floor(time / 864e5) * 864e5 + 12 * 36e5;
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(noon);
    const get = (t) => Number(parts.find((p) => p.type === t).value);
    const dayShift = get('day') - new Date(noon).getUTCDate();
    // Month boundaries: a shift of more than one day means we wrapped the month.
    const days = dayShift > 1 ? -1 : dayShift < -1 ? 1 : dayShift;
    off = days * 1440 + (get('hour') - 12) * 60 + get('minute');
    offsetCache.set(key, off);
  }
  return off;
}

export const berlinOffsetMin = (time) => tzOffsetMin(time, 'Europe/Berlin');

// { day: 'YYYY-MM-DD', mod: minute of day 0..1439, dow: 0=Sunday } in local time of `tz`.
export function localClock(time, tz) {
  const local = time + tzOffsetMin(time, tz) * 6e4;
  const d = new Date(local);
  return {
    day: d.toISOString().slice(0, 10),
    mod: d.getUTCHours() * 60 + d.getUTCMinutes(),
    dow: d.getUTCDay(),
  };
}

// Frankfurt time, where DAX trades.
export const berlinClock = (time) => localClock(time, 'Europe/Berlin');

// '09:15' -> 555
export function hhmm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s));
  if (!m || +m[1] > 23 || +m[2] > 59) throw new Error(`Invalid time "${s}", expected HH:MM`);
  return +m[1] * 60 + +m[2];
}
