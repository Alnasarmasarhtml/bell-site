/**
 * $BELL schedule.
 *
 * Eight bells a day on the New York clock while the market is open:
 * the 9:30 opening bell, hourly bells at 10, 11, 12, 1, 2 and 3, and the
 * 4:00 closing bell. On a 1:00 pm early close day the day has five bells
 * and the 1:00 bell is the closing bell. No rings on weekends or holidays.
 *
 * Plain Node ES module, no dependencies. Every wall clock computation goes
 * through Intl.DateTimeFormat with timeZone 'America/New_York', so daylight
 * saving is handled by the platform tz database rather than by hand.
 *
 * Calendar: the NYSE Group 2026 and 2027 holiday and early close list is
 * verified against nyse.com and the ICE press release (see docs/schedule.md).
 * Years outside that table fall back to the NYSE holiday rules and are
 * flagged verified: false by calendar(year).
 *
 * Conventions used everywhere in this file:
 *   - An "instant" is a JS Date (UTC under the hood).
 *   - A "day key" is the New York calendar date as 'YYYY-MM-DD'.
 *   - Any function that takes a date accepts a Date, a millisecond number,
 *     an ISO instant string, or a bare 'YYYY-MM-DD' day key. A bare day key
 *     means midnight New York time on that date.
 *   - Windows are half open: [start, end). The end instant belongs to the
 *     next window (or to silence).
 */

export const TIME_ZONE = 'America/New_York';

/** Regular session open, New York wall clock. */
export const OPEN = Object.freeze({ hour: 9, minute: 30 });
/** Regular session close, New York wall clock. */
export const CLOSE = Object.freeze({ hour: 16, minute: 0 });
/** Early close, New York wall clock. */
export const EARLY_CLOSE = Object.freeze({ hour: 13, minute: 0 });

/** Years whose calendar was checked against the NYSE published list. */
export const VERIFIED_YEARS = Object.freeze([2026, 2027]);

/** How many calendar days nextRing and previousRing scan before giving up. */
const SEARCH_DAYS = 14;

// ---------------------------------------------------------------------------
// Verified calendar (NYSE Group announcement, November 2024; nyse.com hours
// and calendars page). Keep names identical to the rule generator so the
// test suite can diff the two.
// ---------------------------------------------------------------------------

const VERIFIED_CLOSURES = {
  2026: [
    ['2026-01-01', "New Year's Day"],
    ['2026-01-19', 'Martin Luther King, Jr. Day'],
    ['2026-02-16', "Washington's Birthday"],
    ['2026-04-03', 'Good Friday'],
    ['2026-05-25', 'Memorial Day'],
    ['2026-06-19', 'Juneteenth National Independence Day'],
    ['2026-07-03', 'Independence Day (observed)'],
    ['2026-09-07', 'Labor Day'],
    ['2026-11-26', 'Thanksgiving Day'],
    ['2026-12-25', 'Christmas Day'],
  ],
  2027: [
    ['2027-01-01', "New Year's Day"],
    ['2027-01-18', 'Martin Luther King, Jr. Day'],
    ['2027-02-15', "Washington's Birthday"],
    ['2027-03-26', 'Good Friday'],
    ['2027-05-31', 'Memorial Day'],
    ['2027-06-18', 'Juneteenth National Independence Day (observed)'],
    ['2027-07-05', 'Independence Day (observed)'],
    ['2027-09-06', 'Labor Day'],
    ['2027-11-25', 'Thanksgiving Day'],
    ['2027-12-24', 'Christmas Day (observed)'],
  ],
};

const VERIFIED_EARLY_CLOSES = {
  2026: [
    ['2026-11-27', 'Day after Thanksgiving'],
    ['2026-12-24', 'Christmas Eve'],
  ],
  2027: [
    ['2027-11-26', 'Day after Thanksgiving'],
  ],
};

// ---------------------------------------------------------------------------
// Pure calendar date helpers. These work on UTC midnight Dates and never
// touch time zones, because a calendar date has no zone.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function utcDay(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

function toKey(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function parseKey(key) {
  const m = DAY_KEY_RE.exec(key);
  if (!m) throw new TypeError(`Bad day key: ${key}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

function keyToUtcDay(key) {
  const { year, month, day } = parseKey(key);
  return utcDay(year, month, day);
}

function shiftKey(key, days) {
  return toKey(addDays(keyToUtcDay(key), days));
}

function nthWeekday(year, month, weekday, n) {
  const first = utcDay(year, month, 1);
  const delta = (weekday - first.getUTCDay() + 7) % 7;
  return utcDay(year, month, 1 + delta + (n - 1) * 7);
}

function lastWeekday(year, month, weekday) {
  const last = utcDay(year, month + 1, 0);
  const delta = (last.getUTCDay() - weekday + 7) % 7;
  return utcDay(year, month, last.getUTCDate() - delta);
}

/** Anonymous Gregorian algorithm (Meeus, Jones, Butcher). */
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utcDay(year, month, day);
}

/** Saturday moves to Friday, Sunday moves to Monday. */
function observed(date) {
  const wd = date.getUTCDay();
  if (wd === 6) return addDays(date, -1);
  if (wd === 0) return addDays(date, 1);
  return date;
}

/**
 * Full day closures for any year, from the NYSE holiday rules.
 * Used for years outside VERIFIED_YEARS and diffed against the verified
 * table in the tests.
 * @param {number} year
 * @returns {Array<[string, string]>} sorted [dayKey, name] pairs
 */
export function ruleClosures(year) {
  const list = [];
  const push = (date, name) => list.push([toKey(date), name]);
  const pushObserved = (date, name) => {
    const obs = observed(date);
    push(obs, obs.getTime() === date.getTime() ? name : `${name} (observed)`);
  };

  const newYear = utcDay(year, 1, 1);
  if (newYear.getUTCDay() === 0) {
    push(addDays(newYear, 1), "New Year's Day (observed)");
  } else if (newYear.getUTCDay() !== 6) {
    push(newYear, "New Year's Day");
  }
  // When January 1 is a Saturday the exchange stays open on Friday
  // December 31 (year end accounting), so there is no observed closure.

  push(nthWeekday(year, 1, 1, 3), 'Martin Luther King, Jr. Day');
  push(nthWeekday(year, 2, 1, 3), "Washington's Birthday");
  push(addDays(easterSunday(year), -2), 'Good Friday');
  push(lastWeekday(year, 5, 1), 'Memorial Day');
  pushObserved(utcDay(year, 6, 19), 'Juneteenth National Independence Day');
  pushObserved(utcDay(year, 7, 4), 'Independence Day');
  push(nthWeekday(year, 9, 1, 1), 'Labor Day');
  push(nthWeekday(year, 11, 4, 4), 'Thanksgiving Day');
  pushObserved(utcDay(year, 12, 25), 'Christmas Day');

  return list.sort((x, y) => (x[0] < y[0] ? -1 : 1));
}

/**
 * 1:00 pm early closes for any year, from the NYSE rules: the day after
 * Thanksgiving, July 3 when it lands Monday to Thursday, and December 24
 * when it lands Monday to Thursday.
 * @param {number} year
 * @returns {Array<[string, string]>} sorted [dayKey, name] pairs
 */
export function ruleEarlyCloses(year) {
  const list = [];
  const monToThu = (date) => date.getUTCDay() >= 1 && date.getUTCDay() <= 4;

  const july3 = utcDay(year, 7, 3);
  if (monToThu(july3)) list.push([toKey(july3), 'Day before Independence Day']);

  list.push([toKey(addDays(nthWeekday(year, 11, 4, 4), 1)), 'Day after Thanksgiving']);

  const dec24 = utcDay(year, 12, 24);
  if (monToThu(dec24)) list.push([toKey(dec24), 'Christmas Eve']);

  return list;
}

const calendarCache = new Map();

/**
 * The closure and early close calendar for one year.
 * @param {number} year
 * @returns {{
 *   year: number,
 *   verified: boolean,
 *   closures: ReadonlyArray<{date: string, name: string}>,
 *   earlyCloses: ReadonlyArray<{date: string, name: string}>,
 *   closureMap: Map<string, string>,
 *   earlyCloseMap: Map<string, string>,
 * }}
 */
export function calendar(year) {
  if (calendarCache.has(year)) return calendarCache.get(year);
  const verified = Object.hasOwn(VERIFIED_CLOSURES, year);
  const closures = verified ? VERIFIED_CLOSURES[year] : ruleClosures(year);
  const early = verified ? VERIFIED_EARLY_CLOSES[year] : ruleEarlyCloses(year);
  const asObjects = (pairs) =>
    Object.freeze(pairs.map(([date, name]) => Object.freeze({ date, name })));
  const cal = Object.freeze({
    year,
    verified,
    closures: asObjects(closures),
    earlyCloses: asObjects(early),
    closureMap: new Map(closures),
    earlyCloseMap: new Map(early),
  });
  calendarCache.set(year, cal);
  return cal;
}

// ---------------------------------------------------------------------------
// New York wall clock via Intl. No offsets are hard coded.
// ---------------------------------------------------------------------------

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
});

/**
 * Coerce any accepted input to an instant.
 * A bare 'YYYY-MM-DD' string means midnight New York time on that date.
 * @param {Date|number|string} input
 * @returns {Date}
 */
export function toDate(input) {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) throw new TypeError('Invalid Date');
    return input;
  }
  if (typeof input === 'number') return new Date(input);
  if (typeof input === 'string') {
    if (DAY_KEY_RE.test(input)) {
      const { year, month, day } = parseKey(input);
      return nyWallToDate(year, month, day, 0, 0, 0);
    }
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) throw new TypeError(`Unparseable date: ${input}`);
    return d;
  }
  throw new TypeError(`Unsupported date input: ${String(input)}`);
}

/**
 * The New York wall clock reading of an instant.
 * @param {Date|number|string} [now]
 * @returns {{year: number, month: number, day: number, hour: number,
 *   minute: number, second: number, weekday: number}} month 1 to 12,
 *   hour 0 to 23, weekday 0 (Sunday) to 6 (Saturday)
 */
export function nyParts(now = new Date()) {
  const d = toDate(now);
  const out = {};
  for (const p of partsFormatter.formatToParts(d)) {
    if (p.type === 'weekday') out.weekday = WEEKDAY_INDEX[p.value];
    else if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour,
    minute: out.minute,
    second: out.second,
    weekday: out.weekday,
  };
}

/**
 * New York UTC offset at an instant, in minutes. Minus 300 during standard
 * time (EST), minus 240 during daylight time (EDT).
 * @param {Date|number|string} [now]
 * @returns {number}
 */
export function nyOffsetMinutes(now = new Date()) {
  const d = toDate(now);
  const p = nyParts(d);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const wholeSeconds = Math.floor(d.getTime() / 1000) * 1000;
  return Math.round((asUtc - wholeSeconds) / 60_000);
}

/**
 * The instant for a New York wall clock time.
 *
 * Two pass resolution: guess the offset from the wall time read as UTC,
 * then re-read the offset at the candidate instant and correct if the two
 * disagree (which only happens within a day of a DST change). A wall time
 * inside the spring gap (2:00 to 2:59 on the March change) resolves one
 * hour later, the same way most clocks behave. A wall time inside the
 * autumn repeat (1:00 to 1:59 on the November change) resolves to its first
 * occurrence, the daylight time one. Market hours never fall in either.
 *
 * @param {number} year
 * @param {number} month 1 to 12
 * @param {number} day
 * @param {number} [hour]
 * @param {number} [minute]
 * @param {number} [second]
 * @returns {Date}
 */
export function nyWallToDate(year, month, day, hour = 0, minute = 0, second = 0) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = nyOffsetMinutes(new Date(guess));
  let candidate = guess - first * 60_000;
  const again = nyOffsetMinutes(new Date(candidate));
  if (again !== first) candidate = guess - again * 60_000;

  const check = nyParts(new Date(candidate));
  const asked = Date.UTC(year, month - 1, day, hour, minute, second);
  const got = Date.UTC(check.year, check.month - 1, check.day, check.hour, check.minute, check.second);
  if (got !== asked) {
    // The wall time does not exist (spring gap). Shift forward one hour.
    candidate += 3_600_000;
  }
  return new Date(candidate);
}

/**
 * The New York calendar date of an instant as 'YYYY-MM-DD'.
 * @param {Date|number|string} [now]
 * @returns {string}
 */
export function dayKey(now = new Date()) {
  const p = nyParts(now);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/**
 * Resolve any accepted input to a New York day key.
 * @param {Date|number|string} input
 * @returns {string}
 */
function resolveKey(input) {
  if (typeof input === 'string' && DAY_KEY_RE.test(input)) return input;
  return dayKey(toDate(input));
}

/**
 * Weekday of a New York date, 0 (Sunday) to 6 (Saturday).
 * @param {Date|number|string} [date]
 * @returns {number}
 */
export function weekdayOf(date = new Date()) {
  return keyToUtcDay(resolveKey(date)).getUTCDay();
}

// ---------------------------------------------------------------------------
// Market days and hours.
// ---------------------------------------------------------------------------

/**
 * Name of the full day closure on a date, or null when the market is open.
 * Weekends return null too; use isMarketDay for the combined check.
 * @param {Date|number|string} [date]
 * @returns {string|null}
 */
export function closureName(date = new Date()) {
  const key = resolveKey(date);
  return calendar(parseKey(key).year).closureMap.get(key) ?? null;
}

/**
 * True on Monday to Friday when the exchange is not closed for a holiday.
 * @param {Date|number|string} [date]
 * @returns {boolean}
 */
export function isMarketDay(date = new Date()) {
  const key = resolveKey(date);
  const wd = keyToUtcDay(key).getUTCDay();
  if (wd === 0 || wd === 6) return false;
  return !calendar(parseKey(key).year).closureMap.has(key);
}

/**
 * True on a 1:00 pm early close day.
 * @param {Date|number|string} [date]
 * @returns {boolean}
 */
export function isEarlyClose(date = new Date()) {
  const key = resolveKey(date);
  return isMarketDay(key) && calendar(parseKey(key).year).earlyCloseMap.has(key);
}

/**
 * Session bounds for a New York date.
 * @param {Date|number|string} [date]
 * @returns {{open: Date, close: Date, early: boolean, day: string}|null}
 *   null when the market is closed that day
 */
export function marketHours(date = new Date()) {
  const key = resolveKey(date);
  if (!isMarketDay(key)) return null;
  const { year, month, day } = parseKey(key);
  const early = isEarlyClose(key);
  const closeAt = early ? EARLY_CLOSE : CLOSE;
  return {
    open: nyWallToDate(year, month, day, OPEN.hour, OPEN.minute),
    close: nyWallToDate(year, month, day, closeAt.hour, closeAt.minute),
    early,
    day: key,
  };
}

function wallLabel(hour, minute) {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${pad2(minute)} ${hour < 12 ? 'AM' : 'PM'}`;
}

/**
 * @typedef {object} Ring
 * @property {Date} at the instant the bell rings
 * @property {'open'|'hour'|'close'} kind
 * @property {number} index 0 for the opening bell, then 1, 2, ... in order;
 *   the closing bell is index 7 on a regular day and 4 on an early close day
 * @property {string} day New York day key
 * @property {number} hour New York wall hour, 0 to 23
 * @property {number} minute New York wall minute
 * @property {string} wall wall clock label such as '9:30 AM'
 */

/**
 * Every bell of a New York date in ring order. Eight on a regular day,
 * five on an early close day, none on weekends and holidays.
 * @param {Date|number|string} [date]
 * @returns {Ring[]}
 */
export function ringsForDay(date = new Date()) {
  const hours = marketHours(date);
  if (!hours) return [];
  const { year, month, day } = parseKey(hours.day);
  const closeHour = hours.early ? EARLY_CLOSE.hour : CLOSE.hour;
  const rings = [];
  const push = (at, kind, hour, minute) =>
    rings.push({ at, kind, index: rings.length, day: hours.day, hour, minute, wall: wallLabel(hour, minute) });

  push(hours.open, 'open', OPEN.hour, OPEN.minute);
  for (let h = OPEN.hour + 1; h < closeHour; h += 1) {
    push(nyWallToDate(year, month, day, h, 0), 'hour', h, 0);
  }
  push(hours.close, 'close', closeHour, 0);
  return rings;
}

/**
 * Plain name for a ring kind.
 * @param {Ring|{kind: string}} ring
 * @returns {'opening bell'|'hourly bell'|'closing bell'}
 */
export function ringName(ring) {
  if (ring.kind === 'open') return 'opening bell';
  if (ring.kind === 'close') return 'closing bell';
  return 'hourly bell';
}

/**
 * The first bell strictly after an instant. Scans ahead across weekends
 * and holidays.
 * @param {Date|number|string} [now]
 * @returns {Ring|null} null only if nothing rings within SEARCH_DAYS
 */
export function nextRing(now = new Date()) {
  const t = toDate(now).getTime();
  let key = dayKey(t);
  for (let i = 0; i <= SEARCH_DAYS; i += 1) {
    for (const ring of ringsForDay(key)) {
      if (ring.at.getTime() > t) return ring;
    }
    key = shiftKey(key, 1);
  }
  return null;
}

/**
 * The most recent bell at or before an instant. A bell that rings exactly
 * now counts as the previous ring.
 * @param {Date|number|string} [now]
 * @returns {Ring|null} null only if nothing rang within SEARCH_DAYS
 */
export function previousRing(now = new Date()) {
  const t = toDate(now).getTime();
  let key = dayKey(t);
  for (let i = 0; i <= SEARCH_DAYS; i += 1) {
    const rings = ringsForDay(key);
    for (let j = rings.length - 1; j >= 0; j -= 1) {
      if (rings[j].at.getTime() <= t) return rings[j];
    }
    key = shiftKey(key, -1);
  }
  return null;
}

/**
 * @typedef {object} RaceWindow
 * @property {Date} start the bell that opened the race
 * @property {Date} end the bell that ends the race (exclusive)
 * @property {number} index index of the ring that ends the race, 1 to 7
 *   (1 to 4 on an early close day)
 * @property {Ring} startsAt
 * @property {Ring} endsAt
 * @property {string} day New York day key
 */

/**
 * The buyer race in progress at an instant. Races run between consecutive
 * bells: [9:30, 10:00), [10:00, 11:00), ... [3:00, 4:00). The biggest buyer
 * inside the window wins at the bell that ends it.
 * @param {Date|number|string} [now]
 * @returns {RaceWindow|null} null during silence
 */
export function currentHourWindow(now = new Date()) {
  const t = toDate(now).getTime();
  const rings = ringsForDay(dayKey(t));
  for (let i = 0; i + 1 < rings.length; i += 1) {
    const a = rings[i];
    const b = rings[i + 1];
    if (t >= a.at.getTime() && t < b.at.getTime()) {
      return { start: a.at, end: b.at, index: b.index, startsAt: a, endsAt: b, day: a.day };
    }
  }
  return null;
}

/**
 * The race that a given bell ends. Null for the opening bell, which starts
 * a race but ends none.
 * @param {Ring} ring
 * @returns {RaceWindow|null}
 */
export function raceWindowEndingAt(ring) {
  if (!ring || ring.index === 0) return null;
  const rings = ringsForDay(ring.day);
  const a = rings[ring.index - 1];
  const b = rings[ring.index];
  if (!a || !b) return null;
  return { start: a.at, end: b.at, index: b.index, startsAt: a, endsAt: b, day: b.day };
}

/**
 * True when no race is running: before the open, from the closing bell on,
 * weekends, and holidays.
 * @param {Date|number|string} [now]
 * @returns {boolean}
 */
export function isSilence(now = new Date()) {
  return currentHourWindow(now) === null;
}

/**
 * The silence around an instant: from the last closing bell to the next
 * opening bell. The pool keeps trading through it and the gap builds until
 * the opening bell reveals it.
 * @param {Date|number|string} [now]
 * @returns {{start: Date|null, end: Date|null, from: Ring|null, to: Ring|null}|null}
 *   null while a race is running
 */
export function silenceWindow(now = new Date()) {
  if (!isSilence(now)) return null;
  const from = previousRing(now);
  const to = nextRing(now);
  return { start: from ? from.at : null, end: to ? to.at : null, from, to };
}
