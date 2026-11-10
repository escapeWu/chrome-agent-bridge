// Main-world time-zone override, run at document_start. A profile script
// (page/timezones/*.js) runs just before this file and leaves the IANA zone on
// `globalThis.__CAB_TIMEZONE__`; this file consumes and removes that global.
//
// It aligns Date getters/formatters and Intl.DateTimeFormat with the zone. It does
// not change language, the IP address, cookies, or the operating system time zone.
// Known limits: Date setters and the local-time Date constructor still use the
// operating system's time zone, and Web Workers are not covered.
(() => {
  "use strict";

  const timeZone = globalThis.__CAB_TIMEZONE__;
  try {
    delete globalThis.__CAB_TIMEZONE__;
  } catch {
    globalThis.__CAB_TIMEZONE__ = undefined;
  }
  if (typeof timeZone !== "string") return;

  const appliedMarker = Symbol.for("chrome-agent-bridge.timezone.applied");
  if (globalThis[appliedMarker]) return;
  Object.defineProperty(globalThis, appliedMarker, { value: true });

  const NativeDateTimeFormat = Intl.DateTimeFormat;
  const nativeDateMethods = {
    toLocaleString: Date.prototype.toLocaleString,
    toLocaleDateString: Date.prototype.toLocaleDateString,
    toLocaleTimeString: Date.prototype.toLocaleTimeString,
  };

  function normalizeDateTimeOptions(options) {
    const normalized = options == null ? {} : { ...options };
    if (normalized.timeZone === undefined) normalized.timeZone = timeZone;
    return normalized;
  }

  const WrappedDateTimeFormat = new Proxy(NativeDateTimeFormat, {
    apply: (target, thisArg, args) =>
      Reflect.apply(target, thisArg, [args[0], normalizeDateTimeOptions(args[1]), ...args.slice(2)]),
    construct: (target, args, newTarget) =>
      Reflect.construct(target, [args[0], normalizeDateTimeOptions(args[1]), ...args.slice(2)], newTarget),
  });
  try {
    Object.defineProperty(Intl, "DateTimeFormat", { configurable: true, value: WrappedDateTimeFormat, writable: true });
  } catch {
    // Keep the native constructor if it is locked.
  }

  const partsFormatter = new NativeDateTimeFormat("en-US", {
    day: "2-digit", hour: "2-digit", hourCycle: "h23", minute: "2-digit",
    month: "2-digit", second: "2-digit", timeZone, timeZoneName: "long",
    weekday: "short", year: "numeric",
  });

  function zonedParts(date) {
    if (!Number.isFinite(date.getTime())) return null;
    const values = {};
    for (const part of partsFormatter.formatToParts(date)) {
      if (part.type !== "literal") values[part.type] = part.value;
    }
    return values;
  }

  function timeZoneOffset(date) {
    const parts = zonedParts(date);
    if (!parts) return Number.NaN;
    const representedAsUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second),
      date.getUTCMilliseconds(),
    );
    return Math.round((date.getTime() - representedAsUtc) / 60_000);
  }

  function offsetText(offsetMinutes) {
    const sign = offsetMinutes <= 0 ? "+" : "-";
    const absolute = Math.abs(offsetMinutes);
    const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
    const minutes = String(absolute % 60).padStart(2, "0");
    return `${sign}${hours}${minutes}`;
  }

  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function dateString(date) {
    const parts = zonedParts(date);
    if (!parts) return "Invalid Date";
    return `${parts.weekday} ${monthNames[Number(parts.month) - 1]} ${parts.day} ${parts.year}`;
  }

  function timeString(date) {
    const parts = zonedParts(date);
    if (!parts) return "Invalid Date";
    return `${parts.hour}:${parts.minute}:${parts.second} GMT${offsetText(timeZoneOffset(date))} (${parts.timeZoneName})`;
  }

  const field = (name, adjust = 0) => function () {
    const parts = zonedParts(this);
    return parts ? Number(parts[name]) + adjust : Number.NaN;
  };

  const dateMethodOverrides = {
    getDate: field("day"),
    getFullYear: field("year"),
    getHours: field("hour"),
    getMinutes: field("minute"),
    getMonth: field("month", -1),
    getSeconds: field("second"),
    getDay() {
      const parts = zonedParts(this);
      if (!parts) return Number.NaN;
      return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))).getUTCDay();
    },
    getTimezoneOffset() {
      return timeZoneOffset(this);
    },
    toDateString() {
      return dateString(this);
    },
    toLocaleDateString(locales, options) {
      return nativeDateMethods.toLocaleDateString.call(this, locales, normalizeDateTimeOptions(options));
    },
    toLocaleString(locales, options) {
      return nativeDateMethods.toLocaleString.call(this, locales, normalizeDateTimeOptions(options));
    },
    toLocaleTimeString(locales, options) {
      return nativeDateMethods.toLocaleTimeString.call(this, locales, normalizeDateTimeOptions(options));
    },
    toString() {
      const date = dateString(this);
      return date === "Invalid Date" ? date : `${date} ${timeString(this)}`;
    },
    toTimeString() {
      return timeString(this);
    },
  };

  for (const [name, method] of Object.entries(dateMethodOverrides)) {
    try {
      Object.defineProperty(Date.prototype, name, { configurable: true, value: method, writable: true });
    } catch {
      // Keep the native method if it is locked.
    }
  }
})();
