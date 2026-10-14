// Browser-side region lock, run in the page's main world at document_start.
//
// A profile script (features/page/profiles/*.js) runs just before this file and
// leaves its settings on `globalThis.__CAB_REGION_PROFILE__`; this file consumes
// and removes that global. It aligns navigator language, <html lang>, Intl and
// Date with the profile. It does not touch the public IP, cookies, storage,
// canvas, hardware values, or the page's content.
//
// Known limit: Date setters and the local-time Date constructor still use the
// operating system's time zone. Only the getters and formatters are aligned.
(() => {
  "use strict";

  const profile = globalThis.__CAB_REGION_PROFILE__;
  try {
    delete globalThis.__CAB_REGION_PROFILE__;
  } catch {
    globalThis.__CAB_REGION_PROFILE__ = undefined;
  }
  if (!profile || typeof profile !== "object") return;

  const appliedMarker = Symbol.for("chrome-agent-bridge.region-lock.applied");
  if (globalThis[appliedMarker]) return;
  Object.defineProperty(globalThis, appliedMarker, { value: true });

  const { locale, timeZone } = profile;
  const languages = Object.freeze([...profile.languages]);
  const NativeDateTimeFormat = Intl.DateTimeFormat;
  const nativeDateMethods = {
    toLocaleString: Date.prototype.toLocaleString,
    toLocaleDateString: Date.prototype.toLocaleDateString,
    toLocaleTimeString: Date.prototype.toLocaleTimeString,
  };

  function defineGetter(target, property, getter) {
    if (!target) return;
    const descriptor = Object.getOwnPropertyDescriptor(target, property);
    try {
      Object.defineProperty(target, property, {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        get: getter,
      });
    } catch {
      // A locked descriptor keeps the native value.
    }
  }

  const navigatorPrototype = Object.getPrototypeOf(navigator);
  defineGetter(navigatorPrototype, "language", () => locale);
  defineGetter(navigatorPrototype, "languages", () => languages);

  const normalizeLocales = (locales) => (locales === undefined ? locale : locales);

  function normalizeDateTimeOptions(options) {
    const normalized = options == null ? {} : { ...options };
    if (normalized.timeZone === undefined) normalized.timeZone = timeZone;
    return normalized;
  }

  function wrapIntlConstructor(name, normalizeOptions) {
    const Native = Intl[name];
    if (typeof Native !== "function") return;
    const prepare = (args) => {
      const prepared = [...args];
      prepared[0] = normalizeLocales(prepared[0]);
      if (normalizeOptions) prepared[1] = normalizeOptions(prepared[1]);
      return prepared;
    };
    const Wrapped = new Proxy(Native, {
      apply: (target, thisArg, args) => Reflect.apply(target, thisArg, prepare(args)),
      construct: (target, args, newTarget) => Reflect.construct(target, prepare(args), newTarget),
    });
    try {
      Object.defineProperty(Intl, name, { configurable: true, value: Wrapped, writable: true });
    } catch {
      // Keep the native constructor if it is locked.
    }
  }

  wrapIntlConstructor("DateTimeFormat", normalizeDateTimeOptions);
  for (const name of [
    "Collator", "DisplayNames", "ListFormat", "NumberFormat",
    "PluralRules", "RelativeTimeFormat", "Segmenter",
  ]) {
    wrapIntlConstructor(name, null);
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
      return nativeDateMethods.toLocaleDateString.call(this, normalizeLocales(locales), normalizeDateTimeOptions(options));
    },
    toLocaleString(locales, options) {
      return nativeDateMethods.toLocaleString.call(this, normalizeLocales(locales), normalizeDateTimeOptions(options));
    },
    toLocaleTimeString(locales, options) {
      return nativeDateMethods.toLocaleTimeString.call(this, normalizeLocales(locales), normalizeDateTimeOptions(options));
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

  const applyDocumentLanguage = () => {
    if (!document.documentElement) return false;
    document.documentElement.lang = locale;
    return true;
  };
  if (!applyDocumentLanguage()) {
    const observer = new MutationObserver(() => {
      if (applyDocumentLanguage()) observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  }
})();
