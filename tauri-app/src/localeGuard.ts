const FALLBACK_LOCALE = 'en-US';

const isValidLocale = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    if (typeof Intl.Locale === 'function') {
      new Intl.Locale(value);
    } else {
      new Intl.DateTimeFormat(value);
    }
    return true;
  } catch {
    return false;
  }
};

const validLocaleOrFallback = (value: unknown) => (
  isValidLocale(value) ? value : FALLBACK_LOCALE
);

const installLocaleGuard = () => {
  if (typeof navigator === 'undefined') return;

  const language = validLocaleOrFallback(navigator.language);
  const languages = Array.isArray(navigator.languages)
    ? navigator.languages.filter(isValidLocale)
    : [];
  const safeLanguages = languages.length > 0 ? languages : [language];

  if (language === navigator.language && safeLanguages.length === navigator.languages?.length) {
    return;
  }

  const defineNavigatorValue = (key: 'language' | 'languages' | 'userLanguage', value: unknown) => {
    try {
      Object.defineProperty(navigator, key, {
        configurable: true,
        get: () => value,
      });
    } catch {
      // Some WebKit builds expose navigator fields as non-configurable. In that
      // case the global error handler still records the original locale issue.
    }
  };

  defineNavigatorValue('language', language);
  defineNavigatorValue('languages', safeLanguages);
  defineNavigatorValue('userLanguage', language);
};

installLocaleGuard();

export {};
