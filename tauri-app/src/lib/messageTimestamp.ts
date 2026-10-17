const DAY_MS = 24 * 60 * 60 * 1000;

export interface MessageTimestampLabel {
  label: string;
  title: string;
}

export type MessageTimestampMode = 'time-only' | 'contextual';

const parseDate = (value: string | number | Date): Date | null => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};

const localDayStartMs = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

const formatTime = (
  date: Date,
  locale?: string | string[],
  timeZone?: string,
): string =>
  new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(date);

const formatMonthDay = (
  date: Date,
  locale?: string | string[],
  timeZone?: string,
): string =>
  new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    timeZone,
  }).format(date);

const formatMonthDayYear = (
  date: Date,
  locale?: string | string[],
  timeZone?: string,
): string =>
  new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone,
  }).format(date);

const formatFullTimestamp = (
  date: Date,
  locale?: string | string[],
  timeZone?: string,
): string =>
  new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZone,
  }).format(date);

const getLocalDateParts = (date: Date, timeZone?: string): { year: number; month: number; day: number } => {
  if (!timeZone) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
    };
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    timeZone,
  }).formatToParts(date);
  const partValue = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: partValue('year'),
    month: partValue('month'),
    day: partValue('day'),
  };
};

const localDayStartMsForZone = (date: Date, timeZone?: string): number => {
  if (!timeZone) return localDayStartMs(date);
  const { year, month, day } = getLocalDateParts(date, timeZone);
  return Date.UTC(year, month - 1, day);
};

export function formatMessageTimestamp(
  value: string | number | Date | null | undefined,
  options: {
    now?: string | number | Date;
    locale?: string | string[];
    timeZone?: string;
    mode?: MessageTimestampMode;
  } = {},
): MessageTimestampLabel | null {
  if (value == null) return null;

  const date = parseDate(value);
  if (!date) return null;

  const now = parseDate(options.now ?? new Date()) ?? new Date();
  const locale = options.locale;
  const timeZone = options.timeZone;
  const mode = options.mode ?? 'contextual';
  const time = formatTime(date, locale, timeZone);
  const daysAgo = Math.round(
    (localDayStartMsForZone(now, timeZone) - localDayStartMsForZone(date, timeZone)) / DAY_MS,
  );
  const dateParts = getLocalDateParts(date, timeZone);
  const nowParts = getLocalDateParts(now, timeZone);

  let label: string;
  if (mode === 'time-only' || daysAgo === 0) {
    label = time;
  } else if (daysAgo === 1) {
    label = `Yesterday, ${time}`;
  } else if (dateParts.year === nowParts.year) {
    label = `${formatMonthDay(date, locale, timeZone)}, ${time}`;
  } else {
    label = `${formatMonthDayYear(date, locale, timeZone)}, ${time}`;
  }

  return {
    label,
    title: formatFullTimestamp(date, locale, timeZone),
  };
}
