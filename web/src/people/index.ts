// Placeholder written by the shell task so the build works on its own.
// The people task replaces this whole file at merge with the real screens.
import { h } from 'preact';
import type { Conference, InterestedTalk, Talk } from '../types';

interface PeopleScreenProps {
  conference: Conference;
  interested: InterestedTalk[];
  onOpenTalk: (talk: Talk | string) => void;
}

interface ForYouScreenProps {
  conference: Conference;
  interested: InterestedTalk[];
  onToggleInterested: (talk: Talk | string) => void;
}

interface ProfileScreenProps {
  conference: Conference;
  interested: InterestedTalk[];
}

interface TalkPeopleControlsProps {
  conference: Conference;
  talk: Talk;
  interested: boolean;
}

interface EndedTalkBannerProps {
  conference: Conference;
  interested: InterestedTalk[];
  onOpenTalk: (talk: Talk | string) => void;
}

function placeholder(title: string, body: string, link?: { href: string; label: string }) {
  return h(
    'div',
    { class: 'state' },
    h('p', { class: 'state-title' }, title),
    h('p', { class: 'state-body' }, body),
    link ? h('a', { class: 'btn btn-tonal', href: link.href }, link.label) : null,
  );
}

export function PeopleScreen(_props: PeopleScreenProps) {
  return placeholder('People to meet', 'This screen is not built yet.');
}

export function ForYouScreen(_props: ForYouScreenProps) {
  return placeholder('Talks for you', 'This screen is not built yet.');
}

export function ProfileScreen(_props: ProfileScreenProps) {
  return placeholder('Your profile', 'This screen is not built yet.', { href: '#/settings', label: 'Settings' });
}

export function TalkPeopleControls(_props: TalkPeopleControlsProps) {
  return null;
}

export function EndedTalkBanner(_props: EndedTalkBannerProps) {
  return null;
}
