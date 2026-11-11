import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { ArrowLeft, CalendarX, ChevronLeft, CircleExclamationPoint, ExternalLink, Inbox, Settings, X } from 'lucide-preact';
import type { Conference, Facets, InterestedTalk, SearchFilters, SearchResponse, SearchResult, Talk } from './types';
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
import {
  decodeParam,
  defaultConference,
  goToConference,
  readRoute,
  replaceConference,
  replaceTabParams,
  tabHash,
  type Route,
  type Tab,
  type TabParams,
} from './lib/route';
import { appPath } from './lib/apiBase';
import { visit } from './lib/trail';
import { useFocusTrap } from './lib/focus';
import { AppBar, ConfirmDialog, NavBar, OverflowMenu, Segmented, Toast, type ConfirmData, type ToastData } from './components/common';
import { ChipRow, FilterSheet, Results, SearchField, SuggestionRow, activeFilterCount, type SheetSection } from './components/search';
import { InterestedScreen } from './components/interested';
import { ImportSheet } from './components/import';
import { FullSchedule } from './components/schedule';
import { SettingsScreen } from './components/settings';
import { InstallCard, offerInstallOnce } from './components/install';
import { SwitcherButton, SwitcherSheet } from './components/switcher';
import { TalkCard } from './components/talk';
import {
  BlockedPeople,
  ForYouScreen,
  InboxScreen,
  MeetScreen,
  NudgeSetting,
  NudgeSettings,
  PeopleIMet,
  PeopleIWatch,
  PeopleScreen,
  ProfileScreen,
  onInterestedChanged,
  registerPeopleUi,
  resyncPush,
  startDeleteRetries,
  useInboxCount,
  useInboxWatch,
  usePresenceWatch,
  type TalkLike,
} from './people/index';
import { saveForOffline, useOnline } from './offline/status';
import { maybeStartGuide, replayGuide } from './guide';
import { NeedsConnection, OfflineBadge, OfflineSearch } from './offline/OfflineSearch';

const DEBOUNCE_MS = 350;
const PAGE_SIZE = 20;

// The screens reached from the tab bar. Settings, Profile, Requests and a meet sit on top of them
// and get a Back button instead.
const isTab = (t: Tab) => t !== 'profile' && t !== 'settings' && t !== 'inbox' && t !== 'meet';

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
  // The full schedule (Search tab, Schedule view) keeps its own filters; its day comes from day chips.
  const [schedFilters, setSchedFilters] = useState<SearchFilters>(EMPTY_FILTERS);
  const [schedFacets, setSchedFacets] = useState<{ facets: Facets | null; total: number | null }>({ facets: null, total: null });
  const online = useOnline();

  const { slug, tab, param, params } = route;
  // A push nudge opens #/people?around=1: the People tab with "Around now" on.
  const aroundNow = route.query.get('around') === '1';
  const searchView = params.view === 'schedule' ? 'schedule' : 'search';
  // The view and day last shown on each tab of this conference, so the tab bar returns to them.
  const tabViews = useRef<{ slug: string | null; views: Partial<Record<Tab, TabParams>> }>({ slug: null, views: {} });
  if (tabViews.current.slug !== slug) tabViews.current = { slug, views: {} };
  tabViews.current.views[tab] = params;
  // The screen in the history entry behind this one, so Back from Settings, Profile, Requests or a
  // meet can pop history instead of pushing. Null when it is not known, for example after a reload.
  // #/here/{zone} is never the screen Back leads to, because it turns presence on.
  const prevRoute = useRef<Route | null>(null);
  const lastTabScreen = useRef<Route | null>(null);
  if (isTab(route.tab) && route.tab !== 'here') lastTabScreen.current = route;
  const conference = slug && conferences ? (conferences.find((c) => c.slug === slug) ?? null) : null;
  const searchable = conference?.status === 'searchable' ? conference : null;
  const talks = interested.slug === slug ? interested.talks : [];

  // Find & connect: presence timers and the inbox poll run on every tab while the app is open.
  usePresenceWatch(searchable?.slug ?? null);
  useInboxWatch(searchable?.slug ?? null);
  const inboxCount = useInboxCount(searchable?.slug ?? null);

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

  // The people screens use the shell's one Toast and ConfirmDialog.
  useEffect(() => {
    registerPeopleUi({ toast: showToast, confirm: (d) => setConfirm(d) });
    return () => registerPeopleUi(null);
  }, [showToast]);

  // A profile delete that did not finish last time is tried again now, and again whenever the app
  // comes back to the foreground or back online.
  useEffect(() => startDeleteRetries(), []);

  // A browser whose nudge switch is On tells the server about its push subscription once per load,
  // so a row the server lost is restored without the person doing anything.
  useEffect(() => {
    void resyncPush();
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
    visit(readRoute());
    // A navigation closes any open sheet, so it never stays over the next screen.
    const onRoute = () => {
      const next = readRoute();
      const { duplicate, previous } = visit(next);
      // Chrome fires popstate and hashchange for one hash navigation, so the second is skipped.
      if (duplicate) return;
      setSwitcherOpen(false);
      setOpenTalk(null);
      setImportOpen(false);
      prevRoute.current = previous;
      setRoute(next);
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
    setSchedFilters(EMPTY_FILTERS);
    setSchedFacets({ facets: null, total: null });
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

  // The welcome guide opens by itself on a first visit to an event page, a moment after the shell
  // has rendered, on one of the main tabs, and never over another dialog or sheet.
  const modalOpen = switcherOpen || !!openTalk || importOpen || sheet.open || !!confirm;
  useEffect(() => {
    if (!searchable || !isTab(tab) || tab === 'here') return;
    const t = window.setTimeout(() => {
      const open = modalOpen || !!document.querySelector('[aria-modal="true"], .swal2-container');
      maybeStartGuide(searchable.slug, open, () => tabViews.current.views);
    }, 700);
    return () => window.clearTimeout(t);
  }, [searchable?.slug, tab, modalOpen]);

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

  // Search runs when the Search tab's Search view is shown and its conference or filters changed.
  useEffect(() => {
    if (tab !== 'search' || searchView !== 'search' || !searchable) return;
    // Offline, the keyword search over the saved schedule runs instead; the next online visit
    // searches again.
    if (!online) {
      controller.current?.abort();
      window.clearTimeout(timer.current);
      searchedKey.current = '';
      return;
    }
    if (searchedKey.current !== `${searchable.slug}|${JSON.stringify(filters)}|${ignored.join(',')}`) runSearch();
  }, [tab, searchView, searchable?.slug, filters, ignored, online]);

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
  // "share automatically" themselves, through the same rule as a single mark. The import sheet then
  // confirms, offers Undo, and offers "View my schedule".
  const markImported = (found: SearchResult[]): string[] => {
    const s = latest.current.slug;
    if (!s) return [];
    const current = latest.current.talks;
    const have = new Set(current.map((x) => x.talk_id));
    const added = found.filter((t) => t.conference === s && !have.has(t.talk_id)).map(toInterested);
    if (!added.length) return [];
    const ids = added.map((t) => t.talk_id);
    setInterested(s, [...current, ...added]);
    followShare(s, ids, true);
    offerInstallOnce();
    return ids;
  };

  const unmarkImported = (ids: string[]) => {
    const s = latest.current.slug;
    if (!s) return;
    const remove = new Set(ids);
    setInterested(s, latest.current.talks.filter((x) => !remove.has(x.talk_id)));
    followShare(s, ids, false);
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

  // Screens that belong to one conference and one moment go back to People on a switch.
  const perConference = tab === 'inbox' || tab === 'meet' || tab === 'here';
  const pickConference = (next: string) => {
    setSwitcherOpen(false);
    if (next !== slug) goToConference(next, perConference ? 'people' : tab);
  };

  // #/here/{zone} is the People tab with presence turned on; once handled, the hash becomes #/people.
  const hereHandled = () => {
    if (readRoute().tab !== 'here') return;
    history.replaceState(history.state, '', `${location.pathname}#/people`);
    window.dispatchEvent(new Event('caddie:route'));
  };

  const interestedIds = new Set(talks.map((t) => t.talk_id));
  const base = slug ? appPath(`e/${encodeURIComponent(slug)}`) : '';
  const isTabScreen = isTab(tab);
  const navTab = tab === 'here' || tab === 'inbox' || tab === 'meet' ? 'people' : tab;

  // Back pops history when the previous screen is the one Back leads to, so the browser's Back
  // button and this one agree. Otherwise it links there, for a deep link or a reload.
  const prev = prevRoute.current;
  const backTo =
    tab === 'profile'
      ? { href: '#/settings', pops: prev?.slug === slug && prev?.tab === 'settings' }
      : {
          href: lastTabScreen.current?.slug === slug ? tabHash(lastTabScreen.current.tab, lastTabScreen.current.params) : '#/people',
          pops: prev?.slug === slug && isTab(prev.tab) && prev.tab !== 'here',
        };
  const leading = !isTabScreen ? (
    <a
      class={tab === 'profile' ? 'appbar-back-labeled' : 'icon-btn appbar-back'}
      href={backTo.href}
      aria-label={tab === 'profile' ? 'Back to Settings' : 'Back'}
      onClick={(e) => {
        if (!backTo.pops || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        history.back();
      }}
    >
      {tab === 'profile' ? (
        <>
          <ChevronLeft size={24} aria-hidden="true" />
          <span>Settings</span>
        </>
      ) : (
        <ArrowLeft size={22} aria-hidden="true" />
      )}
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
  ) : tab === 'inbox' ? (
    'Requests'
  ) : tab === 'meet' ? (
    'Meet up'
  ) : (
    'Settings'
  );

  const actions = (
    <>
      {!online && <OfflineBadge />}
      {tab === 'interested' && searchable && (
        <OverflowMenu
          label="Interested options"
          items={[{ label: 'Clear list', destructive: true, disabled: !talks.length, onSelect: clearInterested }]}
        />
      )}
      {isTabScreen && (tab === 'people' || tab === 'here') && searchable && (
        <a class="icon-btn appbar-inbox" href="#/inbox" aria-label={inboxCount ? `Requests, ${inboxCount} new` : 'Requests'}>
          <Inbox size={24} aria-hidden="true" />
          {inboxCount > 0 && (
            <span class="badge nav-badge" aria-hidden="true">
              {inboxCount > 99 ? '99+' : inboxCount}
            </span>
          )}
        </a>
      )}
      {isTabScreen && (
        <a class="icon-btn" href="#/settings" aria-label="Settings" title="Settings">
          <Settings size={24} aria-hidden="true" />
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
      <NavBar tab={navTab} base={base} interestedCount={talks.length} peopleCount={inboxCount} views={tabViews.current.views} />
      <div class="content">
        <AppBar leading={leading} title={title} actions={actions} />
        <main class="main" id="main">
          {tab === 'settings' ? (
            <SettingsScreen
              theme={theme}
              onTheme={setTheme}
              canImport={!!searchable && online}
              importNote={!searchable ? 'Open a conference first' : !online ? 'Needs a connection' : null}
              onHelp={searchable ? () => replayGuide(searchable.slug, () => tabViews.current.views) : undefined}
              onImport={() => {
                setToast(null);
                setImportOpen(true);
              }}
              people={searchable ? <><BlockedPeople conference={searchable} /><PeopleIMet conference={searchable} /><PeopleIWatch conference={searchable} /><NudgeSetting conference={searchable} /><NudgeSettings conference={searchable} /></> : null}
            />
          ) : !searchable ? (
            blocker()
          ) : (
            <>
              {!online && (tab === 'people' || tab === 'here' || tab === 'for-you' || tab === 'inbox' || tab === 'meet') && (
                <NeedsConnection
                  title={tab === 'for-you' ? 'Suggestions need a connection' : 'People to meet needs a connection'}
                  body="They will load when you're back online. Search, your Interested list and your profile still work on this phone."
                />
              )}
              {online && (tab === 'people' || tab === 'here') && (
                <PeopleScreen
                  key={searchable.slug}
                  conference={searchable}
                  interested={talks}
                  onOpenTalk={onOpenTalk}
                  hereZone={tab === 'here' ? param : null}
                  onHereHandled={hereHandled}
                  aroundNow={aroundNow}
                />
              )}
              {online && tab === 'inbox' && <InboxScreen key={searchable.slug} conference={searchable} />}
              {online && tab === 'meet' && param && (
                <MeetScreen key={`${searchable.slug}:${param}`} conference={searchable} meetId={decodeParam(param)} interested={talks} />
              )}
              {online && tab === 'for-you' && (
                <ForYouScreen key={searchable.slug} conference={searchable} interested={talks} onToggleInterested={toggleInterested} />
              )}
              {tab === 'profile' && <ProfileScreen key={searchable.slug} conference={searchable} interested={talks} />}
              {tab === 'search' && (
                <div class="view-switch">
                  <Segmented
                    label="Search or browse the schedule"
                    value={searchView}
                    onChange={(v) => replaceTabParams('search', v === 'schedule' ? { view: 'schedule', day: params.day } : {})}
                    options={[
                      { value: 'search', label: 'Search' },
                      { value: 'schedule', label: 'Schedule' },
                    ]}
                  />
                </div>
              )}
              {tab === 'search' && searchView === 'schedule' && (
                <FullSchedule
                  key={searchable.slug}
                  conference={searchable}
                  online={online}
                  filters={schedFilters}
                  day={params.day ?? null}
                  onDay={(day) => replaceTabParams('search', { view: 'schedule', day })}
                  interestedIds={interestedIds}
                  onToggle={toggleInterested}
                  onOpen={onOpenTalk}
                  onFacets={(facets, total) => setSchedFacets({ facets, total })}
                  filterRow={
                    <ChipRow
                      schedule
                      conference={searchable}
                      filters={schedFilters}
                      facets={schedFacets.facets}
                      nowAvailable={null}
                      phrases={[]}
                      onRemovePhrase={() => undefined}
                      onChange={setSchedFilters}
                      onOpenSheet={(section) => {
                        setToast(null);
                        setSheet({ open: true, section });
                      }}
                    />
                  }
                />
              )}
              {tab === 'search' && searchView === 'search' && !online && (
                <>
                  <SearchField value={input} onInput={onInput} onSubmit={() => undefined} loading={false} />
                  <OfflineSearch conference={searchable} query={input} interestedIds={interestedIds} onToggle={toggleInterested} />
                </>
              )}
              {tab === 'search' && searchView === 'search' && online && (
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
                  <SuggestionRow suggestions={data?.suggestions ?? []} filters={filters} onChange={setFilters} />
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
                  params={params}
                  onParams={(p) => replaceTabParams('interested', p)}
                  onToggle={toggleInterested}
                  onOpen={onOpenTalk}
                  onBrowse={() => (location.hash = '#/search')}
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
          {...(tab === 'search' && searchView === 'schedule'
            ? { schedule: true, filters: schedFilters, facets: schedFacets.facets, total: schedFacets.total, onChange: setSchedFilters }
            : { filters, facets: data?.facets ?? null, total: data && !loading ? data.total : null, onChange: setFilters })}
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
          onUndo={unmarkImported}
          onViewSchedule={(day) => {
            setImportOpen(false);
            location.hash = tabHash('interested', { view: 'day', day });
          }}
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
