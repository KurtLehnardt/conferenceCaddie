// Which alias a setup script may point at the index it creates.
//
// The aliases (caddie-people, caddie-talks, ...) are what the live server reads, so a setup script
// moves one only when asked to or when the index is plainly a new version of it:
// - an explicit --alias (or the script's env override) always wins, and "" means no alias;
// - otherwise the default alias is used only when the index is the script's default index or is
//   named <alias>-v<N>;
// - any other name, such as caddie-dev-x, gets no alias, and `hint` says how to ask for one.

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// True when index is <alias>-v<N>, for example caddie-people-v3 for caddie-people.
export const isVersionOf = (index, alias) => new RegExp(`^${escapeRegExp(alias)}-v\\d+$`).test(index);

// Returns { alias, hint }. alias is '' when no alias step should run; hint is set only when the
// default alias was withheld because of the index name.
export function chooseAlias({ index, explicit, defaultIndex, defaultAlias }) {
  if (explicit !== undefined && explicit !== null) return { alias: explicit, hint: '' };
  if (index === defaultIndex || isVersionOf(index, defaultAlias)) return { alias: defaultAlias, hint: '' };
  return {
    alias: '',
    hint: `Alias ${defaultAlias} left alone: ${index} is not ${defaultAlias}-v<N>. Pass --alias ${defaultAlias} to point it at ${index}.`,
  };
}
