import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, LOCALES, flattenKeys, isRtl, resolveLocale, t } from '../src';
import { ROLES } from '../src';

describe('translations', () => {
  const reference = flattenKeys(LOCALES[DEFAULT_LOCALE]).sort();

  it.each(Object.keys(LOCALES))('%s has exactly the same keys as English', (locale) => {
    expect(flattenKeys(LOCALES[locale]).sort()).toEqual(reference);
  });

  it.each(Object.keys(LOCALES))('%s keeps every {{placeholder}}', (locale) => {
    const placeholders = (s: string) =>
      [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();
    for (const key of reference) {
      expect(placeholders(t(locale, key)), `${locale}:${key}`).toEqual(placeholders(t('en', key)));
    }
  });

  it('has a label for every role', () => {
    for (const role of ROLES) expect(reference).toContain(`roles.${role}`);
  });

  it('interpolates and falls back', () => {
    expect(t('fr', 'members.changeRole', { name: 'Awa' })).toBe('Modifier le rôle de Awa');
    expect(t('fr-CA', 'common.save')).toBe('Enregistrer');
    expect(t('sw', 'common.save')).toBe('Save');
    expect(resolveLocale('en-GB')).toBe('en');
    expect(() => t('en', 'does.not.exist')).toThrow(/Missing translation/);
  });

  it('knows right-to-left languages', () => {
    expect(isRtl('ar-SA')).toBe(true);
    expect(isRtl('fr')).toBe(false);
  });
});
