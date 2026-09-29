import { t as translate } from '@bricx/shared';
import { getLocales } from 'expo-localization';

/** The device's preferred language tag, e.g. "fr-FR". */
export const locale = getLocales()[0]?.languageTag ?? 'en';

/** Translate a key from packages/shared/locales into the device language. */
export function t(key: string, params?: Record<string, string | number>): string {
  return translate(locale, key, params);
}
