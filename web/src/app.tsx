import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { SavedTalk, SearchFilters, SearchResponse, SearchResult } from './types';
import { EMPTY_FILTERS } from './types';
import { ApiError, isAbort, search } from './api';
import { applyTheme, loadSaved, loadTheme, storeSaved, toSaved, type ThemePref } from './lib/storage';
import { overlaps } from './lib/time';
import {
  AppBar,
  ConfirmDialog,
  NavBar,
  OverflowMenu,
  Toast,
  type ConfirmData,
  type Tab,
  type ToastData,
} from './components/common';
import { ChipRow, FilterSheet, Results, SearchField, activeFilterCount, type SheetSection } from './components/search';
import { AgendaScreen } from './components/agenda';
import { SettingsScreen } from './components/settings';

const DEBOUNCE_MS = 350;
const PAGE_SIZE = 20;
const AGENDA_POOL = 30;
const AGENDA_MAX = 5;

function tabFromHash(): Tab {
  const h = location.hash.replace(/^#\/?/, '');
  return h === 'agenda' || h === 'settings' ? h : 'search';
}

const TITLES: Record<Tab, string> = { search: 'Search', agenda: 'Agenda', settings: 'Settings' };

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Search is unavailable right now. Please try again.';
}

export function App() {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [theme, setTheme] = useState<ThemePref>(loadTheme);
  const [saved, setSavedState] = useState<SavedTalk[]>(loadSaved);
  const [toast, setToast] = useState<ToastData | null>(null);
  const [confirm, setConfirm] = useState<ConfirmData | null>(null);

  // Search state lives here so it survives tab switches.
  const [input, setInput] = useState('');
  const [filters, setFilters] = useState<SearchFilters>(EMPTY_FILTERS);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [lastQuery, setLastQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [sheet, setSheet] = useState<{ open: boolean; section?: SheetSection }>({ open: false });

  const controller = useRef<AbortController | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef({ input, filters, saved });
  latest.current = { input, filters, saved };
  const searchedWith = useRef('');

  const setSaved = useCallback((next: SavedTalk[]) => {
    setSavedState(next);
    storeSaved(next);
  }, []);

  const showToast = useCallback((message: string, action?: ToastData['action']) => {
    setToast({ id: Date.now(), message, action });
  }, []);

  const runSearch = useCallback(async (savedOverride?: SavedTalk[]) => {
    window.clearTimeout(timer.current);
    controller.current?.abort();
    const ctrl = new AbortController();
    controller.current = ctrl;
    const { input: q, filters: f } = latest.current;
    const ids = (savedOverride ?? latest.current.saved).map((t) => t.talk_id);
    searchedWith.current = ids.join(',');
    setLoading(true);
    try {
      const res = await search(q, f, ids, PAGE_SIZE, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setData(res);
      setLastQuery(q.trim());
      setError(null);
    } catch (err) {
      if (isAbort(err)) return;
      setError(errorMessage(err));
    } finally {
      if (controller.current === ctrl) setLoading(false);
    }
  }, []);

  // Hash routing keeps the back button working without a router library.
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    window.scrollTo(0, 0);
    // The agenda may have changed elsewhere; refresh so clashes drop out.
    if (tab === 'search' && data && searchedWith.current !== saved.map((t) => t.talk_id).join(',')) {
      runSearch();
    }
  }, [tab]);

  // Filter changes search immediately.
  useEffect(() => {
    runSearch();
  }, [filters]);

  useEffect(() => applyTheme(theme), [theme]);

  const onInput = (v: string) => {
    setInput(v);
    latest.current.input = v;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => runSearch(), DEBOUNCE_MS);
  };

  const toggleSaved = (r: SearchResult | SavedTalk) => {
    const current = latest.current.saved;
    if (current.some((s) => s.talk_id === r.talk_id)) {
      const removedIndex = current.findIndex((s) => s.talk_id === r.talk_id);
      const removed = current[removedIndex];
      setSaved(current.filter((s) => s.talk_id !== r.talk_id));
      showToast('Removed from your agenda', {
        label: 'Undo',
        onClick: () => {
          const now = latest.current.saved.filter((s) => s.talk_id !== removed.talk_id);
          now.splice(Math.min(removedIndex, now.length), 0, removed);
          setSaved(now);
        },
      });
    } else {
      const t = toSaved(r);
      setSaved([...current, t]);
      showToast('Saved to your agenda', {
        label: 'Undo',
        onClick: () => setSaved(latest.current.saved.filter((s) => s.talk_id !== t.talk_id)),
      });
    }
  };

  // Build my agenda: walk the results in Elasticsearch rank order, skip any
  // talk that overlaps a saved talk or one picked earlier, save up to five.
  const buildAgenda = async () => {
    if (building) return;
    setBuilding(true);
    const { input: q, filters: f, saved: current } = latest.current;
    try {
      const res = await search(
        q,
        f,
        current.map((t) => t.talk_id),
        AGENDA_POOL,
        new AbortController().signal,
      );
      const picked: SavedTalk[] = [];
      for (const r of res.results) {
        if (current.some((s) => s.talk_id === r.talk_id || overlaps(s, r))) continue;
        if (picked.some((p) => overlaps(p, r))) continue;
        picked.push(toSaved(r));
        if (picked.length === AGENDA_MAX) break;
      }
      if (!picked.length) {
        showToast('No more talks fit around your agenda. Try another search.');
        return;
      }
      const next = [...current, ...picked];
      setSaved(next);
      const ids = new Set(picked.map((p) => p.talk_id));
      showToast(`Added ${picked.length} ${picked.length === 1 ? 'talk' : 'talks'} to your agenda`, {
        label: 'Undo',
        onClick: () => {
          const restored = latest.current.saved.filter((s) => !ids.has(s.talk_id));
          setSaved(restored);
          runSearch(restored);
        },
      });
      runSearch(next);
    } catch (err) {
      showToast(isAbort(err) ? 'Cancelled.' : 'Could not build your agenda. Please try again.');
    } finally {
      setBuilding(false);
    }
  };

  const clearAgenda = () => {
    setToast(null);
    setConfirm({
      title: 'Clear your agenda?',
      body: `This removes all ${saved.length} saved ${saved.length === 1 ? 'talk' : 'talks'} from this device.`,
      confirmLabel: 'Clear',
      onConfirm: () => {
        const before = latest.current.saved;
        setSaved([]);
        showToast('Agenda cleared', { label: 'Undo', onClick: () => setSaved(before) });
      },
    });
  };

  const browse = lastQuery === '';
  const filtersActive = activeFilterCount(filters) > 0;

  return (
    <div class="shell">
      <NavBar tab={tab} savedCount={saved.length} />
      <div class="content">
        <AppBar
          title={TITLES[tab]}
          actions={
            tab === 'agenda' ? (
              <OverflowMenu
                label="Agenda options"
                items={[{ label: 'Clear agenda', destructive: true, disabled: !saved.length, onSelect: clearAgenda }]}
              />
            ) : null
          }
        />
        <main class="main" id="main">
          {tab === 'search' && (
            <>
              <SearchField value={input} onInput={onInput} onSubmit={() => runSearch()} loading={loading} />
              <ChipRow filters={filters} onChange={setFilters} onOpenSheet={(section) => {
                  setToast(null);
                  setSheet({ open: true, section });
                }}
              />
              <Results
                data={data}
                browse={browse}
                loading={loading}
                error={error}
                saved={saved}
                building={building}
                filtersActive={filtersActive}
                onRetry={() => runSearch()}
                onToggle={toggleSaved}
                onBuild={buildAgenda}
                onClearFilters={() => setFilters(EMPTY_FILTERS)}
              />
            </>
          )}
          {tab === 'agenda' && (
            <AgendaScreen saved={saved} onRemove={toggleSaved} onBrowse={() => (location.hash = '#/search')} />
          )}
          {tab === 'settings' && (
            <SettingsScreen
              theme={theme}
              onTheme={setTheme}
              savedCount={saved.length}
              onClearSaved={() => {
                setToast(null);
                setConfirm({
                  title: 'Clear saved talks?',
                  body: `This removes all ${saved.length} saved ${saved.length === 1 ? 'talk' : 'talks'} from this device. This cannot be undone.`,
                  confirmLabel: 'Clear',
                  onConfirm: () => setSaved([]),
                });
              }}
            />
          )}
        </main>
      </div>
      <FilterSheet
        open={sheet.open}
        section={sheet.section}
        filters={filters}
        facets={data?.facets ?? null}
        total={data && !loading ? data.total : null}
        onChange={setFilters}
        onClose={() => setSheet({ open: false })}
      />
      <ConfirmDialog data={confirm} onClose={() => setConfirm(null)} />
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
