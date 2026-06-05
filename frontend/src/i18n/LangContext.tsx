import { createContext, useContext, type ReactNode } from 'react'
import type { Lang } from '@/types/app'
import { translations, type TKey } from './translations'

const LangContext = createContext<Lang>('en')

export function LangProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  return <LangContext.Provider value={lang}>{children}</LangContext.Provider>
}

/** Returns the current language. Use when you need lang for dynamic/interpolated strings. */
// eslint-disable-next-line react-refresh/only-export-components
export function useLang(): Lang {
  return useContext(LangContext)
}

/** Returns a t(key) lookup function for static UI strings. */
// eslint-disable-next-line react-refresh/only-export-components
export function useT(): (key: TKey) => string {
  const lang = useLang()
  return (key: TKey) => translations[lang][key]
}
