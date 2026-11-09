import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { ArrowLeft, CalendarX, CircleExclamationPoint, CircleUserRound, ExternalLink, FileUp, X } from 'lucide-preact';
import type { Conference, InterestedTalk, SearchFilters, SearchResponse, SearchResult, Talk } from './types';
import { EMPTY_FILTERS } from './types';
import { ApiError, getConferences, isAbort, search } from './api';
import {
  applyTheme,
  loadConferences,
  loadInterested,
  loadTheme,
  storeConferences,
  storeInterested,
  toInterested,
  type ThemePref,
} from './lib/storage';
import { defaultConference, goToConference, readRoute, replaceConference, type Route } from './lib/route';
import { useFocusTrap } from './lib/focus';
import { AppBar, ConfirmDialog, NavBar, OverflowMenu, Toast, type ConfirmData, type ToastData } from './components/common';
import { ChipRow, FilterSheet, Results, SearchField, activeFilterCount, type SheetSection } from './components/search';
import { InterestedScreen } from './components/interested';
import { ImportSheet } from './components/import';
import { SettingsScreen } from './components/settings';
import { InstallCard, offerInstallOnce } from './components/install';
import { SwitcherButton, SwitcherSheet } from './components/switcher';
import { TalkCard } from './components/talk';
import { ForYouScreen, PeopleScreen, ProfileScreen, onInterestedChanged, type TalkLike } from './people/index';
import { saveForOffline, useOnline } from './offline/status';
import { NeedsConnection, OfflineBadge, OfflineSearch } from './offline/OfflineSearch';

const DEBOUNCE_MS = 350;
const PAGE_SIZE = 20;

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Search is unavailable right now. Please try again.';
}

/** A single talk in a bottom sheet, opened from the People screen or its banner. */
function TalkSheet({
  talk,
  conference,
  interested,
  onToggle,
  onClose,
}: {
  talk: Talk | null;
  conference: Conference;
  interested: boolean;
  onToggle: (t: Talk) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, !!talk, onClose);
  if (!talk) return null;
  return (
    <div class="scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label={talk.title} ref={ref} tabIndex={-1}>
        <div class="sheet-handle" aria-hidden="true" />
        <header class="sheet-header">
          <h2>Talk</h2>
          <button type="button" class="icon-btn" aria-label="Close" onClick={onClose}>
            <X size={22} aria-hidden="true" />
          </button>
        </header>
        <div class="sheet-body sheet-talk">
          <TalkCard talk={talk} conference={conference} interested={interested} onToggleInterested={onToggle} headingLevel={2} />
        </div>
      </div>
    </div>
  );
}

export function App() {
  const [route, setRoute] = useState<Route>(readRoute);
  const [conferences, setConferences] = useState<Conference[] | null>(loadConferences);
  const [confError, setConfError] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemePref>(loadTheme);
  const [interested, setInterestedState] = useState<{ slug: string; talks: InterestedTalk[] }>(() => ({
    slug: route.slug ?? '',
    talks: route.slug ? loadInterested(route.slug) : [],
  }));
  const [toast, setToast] = useState<ToastData | null>(null);
  const [confirm, setConfirm] = useState<ConfirmData | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [openTalk, setOpenTalk] = useState<Talk | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  // Search state lives here so it survives tab switches; it resets per conference.
  const [input, setInput] = useState('');
  const [filters, setFilters] = useState<SearchFilters>(EMPTY_FILTERS);
  // Time phrases ("tuesday", "after lunch") whose chip the person removed.
  const [ignored, setIgnored] = useState<string[]>([]);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [lastQuery, setLastQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ open: boolean; section?: SheetSection }>({ open: false });
  const online = useOnline();

  const { slug, tab } = route;
  const conference = slug && conferences ? (conferences.find((c) => c.slug === slug) ?? null) : null;
  const searchable = conference?.status === 'searchable' ? conference : null;
  const talks = interested.slug === slug ? interested.talks : [];

  const controller = useRef<AbortController | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef({ input, filters, ignored, slug: searchable?.slug ?? null, talks, data });
  latest.current = { input, filters, ignored, slug: searchable?.slug ?? null, talks, data };
  const searchedKey = useRef('');
  // The request behind the results on screen, so the ranking drawer can ask for the same search.
  const dataParams = useRef<{ s: string; q: string; f: SearchFilters; ig: string[] } | null>(null);

  const showToast = useCallback((message: string, action?: ToastData['action']) => {
    setToast({ id: Date.now(), message, action });
  }, []);

  const loadList = useCallback(async () => {
    try {
      const res = await getConferences();
      setConferences(res.conferences);
      storeConferences(res.conferences);
      setConfError(null);
    } catch (err) {
      if (!isAbort(err)) setConfError(err instanceof ApiError ? err.message : 'Conferences are temporarily unavailable.');
    }
  }, []);

  useEffect(() => {
    loadList();
    // A navigation closes any open sheet, so it never stays over the next screen.
    const onRoute = () => {
      setSwitcherOpen(false);
      setOpenTalk(null);
      setImportOpen(false);
      setRoute(readRoute());
    };
    window.addEventListener('popstate', onRoute);
    window.addEventListener('hashchange', onRoute);
    window.addEventListener('caddie:route', onRoute);
    return () => {
      window.removeEventListener('popstate', onRoute);
      window.removeEventListener('hashchange', onRoute);
      window.removeEventListener('caddie:route', onRoute);
    };
  }, []);

  // "/" goes to the default conference once the list is known.
  useEffect(() => {
    if (slug !== null || !conferences) return;
    const c = defaultConference(conferences);
    if (c) replaceConference(c.slug, tab);
  }, [slug, conferences]);

  // A new conference brings its own interested list and a clean search.
  useEffect(() => {
    if (interested.slug !== (slug ?? '')) {
      setInterestedState({ slug: slug ?? '', talks: slug ? loadInterested(slug) : [] });
    }
    controller.current?.abort();
    window.clearTimeout(timer.current);
    searchedKey.current = '';
    // Filters name the old conference's values, so they must not reach the next search.
    latest.current.filters = EMPTY_FILTERS;
    latest.current.ignored = [];
    setFilters(EMPTY_FILTERS);
    setIgnored([]);
    setData(null);
    setError(null);
    setLoading(false);
    setOpenTalk(null);
    setImportOpen(false);
    setSheet({ open: false });
  }, [slug]);

  useEffect(() => {
    document.title = conference ? `${conference.name} · Conference Caddie` : 'Conference Caddie';
  }, [conference?.name]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [tab, slug]);

  useEffect(() => applyTheme(theme), [theme]);

  // Back online: refresh the conference list. Online: save the current conference's schedule
  // shortly after it opens, so airplane mode works right away.
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current) loadList();
    wasOnline.current = online;
  }, [online]);

  useEffect(() => {
    if (!online || !searchable) return;
    const s = searchable.slug;
    const t = window.setTimeout(() => saveForOffline(s), 1500);
    return () => window.clearTimeout(t);
  }, [online, searchable?.slug]);

  const setInterested = useCallback((forSlug: string, next: InterestedTalk[]) => {
    setInterestedState({ slug: forSlug, talks: next });
    storeInterested(forSlug, next);
  }, []);

  const runSearch = useCallback(async () => {
    window.clearTimeout(timer.current);
    controller.current?.abort();
    const { input: q, filters: f, ignored: ig, slug: s } = latest.current;
    if (!s) return;
    const ctrl = new AbortController();
    controller.current = ctrl;
    searchedKey.current = `${s}|${JSON.stringify(f)}|${ig.join(',')}`;
    setLoading(true);
    try {
      const res = await search(s, q, f, PAGE_SIZE, ctrl.signal, false, ig);
      if (ctrl.signal.aborted || latest.current.slug !== s) return;
      dataParams.current = { s, q, f, ig };
      setData(res);
      // The text the search really ran on: time phrases have left it.
      setLastQuery((res.search_text ?? q).trim());
      // A removed phrase that is no longer in the text is forgotten, so typing it again filters
      // again. Dropping it changes nothing about this search, so no new search is needed.
      const kept = ig.filter((k) => res.time_phrases?.some((p) => p.key === k));
      if (kept.length !== ig.length && latest.current.ignored === ig) {
        latest.current.ignored = kept;
        searchedKey.current = `${s}|${JSON.stringify(f)}|${kept.join(',')}`;
        setIgnored(kept);
      }
      setError(null);
    } catch (err) {
      if (isAbort(err)) return;
      setError(errorMessage(err));
    } finally {
      if (controller.current === ctrl) setLoading(false);
    }
  }, []);

  // Search runs when the Search tab is shown and its conference or filters changed.
  useEffect(() => {
    if (tab !== 'search' || !searchable) return;
    // Offline, the keyword search over the saved schedule runs instead; the next online visit
    // searches again.
    if (!online) {
      controller.current?.abort();
      window.clearTimeout(timer.current);
      searchedKey.current = '';
      return;
    }
    if (searchedKey.current !== `${searchable.slug}|${JSON.stringify(filters)}|${ignored.join(',')}`) runSearch();
  }, [tab, searchable?.slug, filters, ignored, online]);

  const onInput = (v: string) => {
    setInput(v);
    latest.current.input = v;
    window.clearTimeout(timer.current);
    if (!online) return;
    timer.current = window.setTimeout(() => runSearch(), DEBOUNCE_MS);
  };

  // The people screens pass talk objects that carry the full search result shape
  // (recommendations and Interested entries), typed structurally as TalkLike.
  // With "sharing follows Interested" on, a mark or unmark also changes the shared-talk list.
  // Anything that stops the share (no name on the profile yet, the 50-talk limit, a failed write)
  // is shown here, since the list changed on a screen without the sharing controls.
  const followShare = (s: string, ids: string[], marked: boolean) =>
    void onInterestedChanged(s, ids, marked).then((message) => {
      if (!message) return;
      showToast(message, message.includes('profile') ? { label: 'Open profile', onClick: () => (location.hash = '#/profile') } : undefined);
    });

  const toggleInterested = (input: Talk | TalkLike | string) => {
    const s = latest.current.slug;
    if (!s) return;
    const t = input as Talk | string;
    const current = latest.current.talks;
    const id = typeof t === 'string' ? t : t.talk_id;
    const index = current.findIndex((x) => x.talk_id === id);
    if (index >= 0) {
      const removed = current[index];
      setInterested(s, current.filter((x) => x.talk_id !== id));
      followShare(s, [id], false);
      showToast('Removed from Interested', {
        label: 'Undo',
        onClick: () => {
          const now = latest.current.talks.filter((x) => x.talk_id !== removed.talk_id);
          now.splice(Math.min(index, now.length), 0, removed);
          setInterested(s, now);
          followShare(s, [removed.talk_id], true);
        },
      });
      return;
    }
    if (typeof t === 'string' || t.conference !== s) return;
    const added = toInterested(t);
    setInterested(s, [...current, added]);
    followShare(s, [added.talk_id], true);
    offerInstallOnce();
    showToast('Added to Interested', {
      label: 'Undo',
      onClick: () => {
        setInterested(s, latest.current.talks.filter((x) => x.talk_id !== added.talk_id));
        followShare(s, [added.talk_id], false);
      },
    });
  };

  const onOpenTalk = (input: Talk | TalkLike | string) => {
    const t = input as Talk | string;
    if (typeof t !== 'string') return setOpenTalk(t);
    const found =
      latest.current.talks.find((x) => x.talk_id === t) ?? latest.current.data?.results.find((x) => x.talk_id === t);
    if (found) setOpenTalk(found);
  };

  // Imported talks are added to the device list only. Sharing changes only when the user turned on
  // "share automatically" themselves, through the same rule as a single mark.
  const markImported = (found: SearchResult[]) => {
    const s = latest.current.slug;
    if (!s) return;
    const current = latest.current.talks;
    const have = new Set(current.map((x) => x.talk_id));
    const added = found.filter((t) => t.conference === s && !have.has(t.talk_id)).map(toInterested);
    setImportOpen(false);
    if (!added.length) return;
    const ids = added.map((t) => t.talk_id);
    setInterested(s, [...current, ...added]);
    followShare(s, ids, true);
    offerInstallOnce();
    showToast(`Marked ${added.length} ${added.length === 1 ? 'talk' : 'talks'} as Interested`, {
      label: 'Undo',
      onClick: () => {
        const remove = new Set(ids);
        setInterested(s, latest.current.talks.filter((x) => !remove.has(x.talk_id)));
        followShare(s, ids, false);
      },
    });
  };

  const clearInterested = () => {
    const s = latest.current.slug;
    if (!s) return;
    setToast(null);
    const n = talks.length;
    setConfirm({
      title: 'Clear your Interested list?',
      body: `This removes all ${n} ${n === 1 ? 'talk' : 'talks'} you marked for this conference from this device.`,
      confirmLabel: 'Clear',
      onConfirm: () => {
        const before = latest.current.talks;
        const ids = before.map((x) => x.talk_id);
        setInterested(s, []);
        followShare(s, ids, false);
        showToast('Interested list cleared', {
          label: 'Undo',
          onClick: () => {
            setInterested(s, before);
            followShare(s, ids, true);
          },
        });
      },
    });
  };

  const pickConference = (next: string) => {
    setSwitcherOpen(false);
    if (next !== slug) goToConference(next, tab === 'settings' ? 'people' : tab);
  };

  const interestedIds = new Set(talks.map((t) => t.talk_id));
  const base = slug ? `/e/${encodeURIComponent(slug)}` : '';
  const isTabScreen = tab !== 'profile' && tab !== 'settings';

  const leading = !isTabScreen ? (
    <a class="icon-btn appbar-back" href={tab === 'settings' ? '#/profile' : '#/people'} aria-label="Back">
      <ArrowLeft size={22} aria-hidden="true" />
    </a>
  ) : null;

  const title = isTabScreen ? (
    <SwitcherButton
      name={conference?.name ?? (conferences ? 'Choose a conference' : 'Conference Caddie')}
      onOpen={() => {
        setToast(null);
        setSwitcherOpen(true);
      }}
    />
  ) : tab === 'profile' ? (
    'Profile'
  ) : (
    'Settings'
  );

  const actions = (
    <>
      {!online && <OfflineBadge />}
      {tab === 'interested' && searchable && online && (
        <button
          type="button"
          class="icon-btn"
          aria-label="Import my schedule"
          title="Import my schedule"
          onClick={() => {
            setToast(null);
            setImportOpen(true);
          }}
        >
          <FileUp size={22} aria-hidden="true" />
        </button>
      )}
      {tab === 'interested' && searchable && (
        <OverflowMenu
          label="Interested options"
          items={[{ label: 'Clear list', destructive: true, disabled: !talks.length, onSelect: clearInterested }]}
        />
      )}
      {isTabScreen && (
        <a class="icon-btn" href="#/profile" aria-label="Your profile">
          <CircleUserRound size={24} aria-hidden="true" />
        </a>
      )}
    </>
  );

  // What to show instead of a conference screen when there is no searchable conference.
  function blocker() {
    if (!conferences) {
      if (confError) {
        return (
          <div class="state">
            <CircleExclamationPoint size={40} class="state-icon" aria-hidden="true" />
            <p class="state-title">Something went wrong</p>
            <p class="state-body">{confError}</p>
            <button type="button" class="btn btn-tonal" onClick={loadList}>
              Retry
            </button>
          </div>
        );
      }
      return (
        <div class="state" aria-busy="true">
          <p class="state-body">Loading conferences…</p>
        </div>
      );
    }
    if (!conference) {
      return (
        <div class="state">
          <CalendarX size={40} class="state-icon" aria-hidden="true" />
          <p class="state-title">{slug === null ? 'No conferences yet' : "This conference isn't available here"}</p>
          <p class="state-body">Choose another conference to continue.</p>
          <button type="button" class="btn btn-tonal" onClick={() => setSwitcherOpen(true)}>
            Choose a conference
          </button>
        </div>
      );
    }
    return (
      <div class="state">
        <CalendarX size={40} class="state-icon" aria-hidden="true" />
        <p class="state-title">Schedule not available here yet</p>
        <p class="state-body">{conference.name} can't be searched here yet. Its schedule is on the official site.</p>
        <a class="btn btn-tonal" href={conference.official_schedule_url} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={18} aria-hidden="true" />
          Open the official schedule
        </a>
      </div>
    );
  }

  return (
    <div class="shell">
      <NavBar tab={tab} base={base} interestedCount={talks.length} />
      <div class="content">
        <AppBar leading={leading} title={title} actions={actions} />
        <main class="main" id="main">
          {tab === 'settings' ? (
            <SettingsScreen theme={theme} onTheme={setTheme} />
          ) : !searchable ? (
            blocker()
          ) : (
            <>
              {!online && (tab === 'people' || tab === 'for-you') && (
                <NeedsConnection
                  title={tab === 'people' ? 'People to meet needs a connection' : 'Suggestions need a connection'}
                  body="They will load when you're back online. Search, your Interested list and your profile still work on this phone."
                />
              )}
              {online && tab === 'people' && (
                <PeopleScreen key={searchable.slug} conference={searchable} interested={talks} onOpenTalk={onOpenTalk} />
              )}
              {online && tab === 'for-you' && (
                <ForYouScreen key={searchable.slug} conference={searchable} interested={talks} onToggleInterested={toggleInterested} />
              )}
              {tab === 'profile' && <ProfileScreen key={searchable.slug} conference={searchable} interested={talks} />}
              {tab === 'search' && !online && (
                <>
                  <SearchField value={input} onInput={onInput} onSubmit={() => undefined} loading={false} />
                  <OfflineSearch conference={searchable} query={input} interestedIds={interestedIds} onToggle={toggleInterested} />
                </>
              )}
              {tab === 'search' && online && (
                <>
                  <SearchField value={input} onInput={onInput} onSubmit={() => runSearch()} loading={loading} />
                  <ChipRow
                    conference={searchable}
                    filters={filters}
                    facets={data?.facets ?? null}
                    nowAvailable={data?.happening_now?.available ?? null}
                    phrases={(data?.time_phrases ?? []).filter((p) => p.applied)}
                    onRemovePhrase={(key) => setIgnored([...ignored, key])}
                    onChange={setFilters}
                    onOpenSheet={(section) => {
                      setToast(null);
                      setSheet({ open: true, section });
                    }}
                  />
                  <Results
                    conference={searchable}
                    data={data}
                    browse={lastQuery === ''}
                    loading={loading}
                    error={error}
                    interestedIds={interestedIds}
                    filtersActive={activeFilterCount(filters) > 0}
                    includeEvents={filters.include_events}
                    onRetry={() => runSearch()}
                    onToggle={toggleInterested}
                    onClearFilters={() => setFilters(EMPTY_FILTERS)}
                    onExplain={() => {
                      const p = dataParams.current;
                      if (!p) return Promise.reject(new Error('no search'));
                      return search(p.s, p.q, p.f, PAGE_SIZE, new AbortController().signal, true, p.ig);
                    }}
                  />
                </>
              )}
              {tab === 'interested' && (
                <InterestedScreen
                  conference={searchable}
                  interested={talks}
                  onToggle={toggleInterested}
                  onBrowse={() => (location.hash = '#/search')}
                  onImport={() => {
                    setToast(null);
                    setImportOpen(true);
                  }}
                />
              )}
            </>
          )}
        </main>
      </div>
      {searchable && (
        <FilterSheet
          conference={searchable}
          open={sheet.open}
          section={sheet.section}
          filters={filters}
          facets={data?.facets ?? null}
          total={data && !loading ? data.total : null}
          onChange={setFilters}
          onClose={() => setSheet({ open: false })}
        />
      )}
      {searchable && (
        <TalkSheet
          talk={openTalk}
          conference={searchable}
          interested={!!openTalk && interestedIds.has(openTalk.talk_id)}
          onToggle={toggleInterested}
          onClose={() => setOpenTalk(null)}
        />
      )}
      {searchable && (
        <ImportSheet
          open={importOpen && online}
          conference={searchable}
          interestedIds={interestedIds}
          onClose={() => setImportOpen(false)}
          onMark={markImported}
          onSwitchConference={() => {
            setImportOpen(false);
            setSwitcherOpen(true);
          }}
        />
      )}
      <SwitcherSheet
        open={switcherOpen}
        conferences={conferences}
        current={slug}
        error={confError}
        onPick={pickConference}
        onClose={() => setSwitcherOpen(false)}
      />
      <ConfirmDialog data={confirm} onClose={() => setConfirm(null)} />
      <Toast toast={toast} onDismiss={() => setToast(null)} />
      <InstallCard />
    </div>
  );
}
