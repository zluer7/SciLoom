import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { translations, type Language, type TranslationKey } from "./translations";

const LANGUAGE_KEY = "researchpilot.language";

type I18nContextValue = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: TranslationKey) => string;
};

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

function getInitialLanguage(): Language {
  if (typeof window === "undefined" || !window.localStorage) {
    return "zh-CN";
  }

  const stored = window.localStorage.getItem(LANGUAGE_KEY);
  return stored === "en-US" || stored === "zh-CN" ? stored : "zh-CN";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(getInitialLanguage);

  const value = useMemo<I18nContextValue>(() => {
    function setLanguage(nextLanguage: Language) {
      setLanguageState(nextLanguage);
      window.localStorage.setItem(LANGUAGE_KEY, nextLanguage);
    }

    function t(key: TranslationKey) {
      return translations[language][key] ?? translations["en-US"][key] ?? key;
    }

    return { language, setLanguage, t };
  }, [language]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within I18nProvider.");
  }
  return context;
}
