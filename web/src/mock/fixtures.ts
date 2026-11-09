// MOCK_FIXTURE_DO_NOT_SHIP
// Placeholder talks for local development with VITE_MOCK=1 only. None of this
// is real schedule data, and production builds must never contain this file.
import type { Talk } from '../types';

export const MOCK_MARKER = 'MOCK_FIXTURE_DO_NOT_SHIP';

export interface MockTalk extends Talk {
  abstract: string;
  sponsor: boolean;
}

const BASE = 'https://example.invalid/mock-session/';

function talk(
  letter: string,
  day: string,
  start: string,
  end: string,
  extra: Partial<MockTalk>,
): MockTalk {
  const id = `mock-${letter.toLowerCase()}`;
  return {
    talk_id: id,
    title: `Sample talk ${letter}`,
    speakers: ['Sample Speaker One'],
    room: 'Sample Room 1',
    start: `${day}T${start}:00-07:00`,
    end: `${day}T${end}:00-07:00`,
    track: 'Sample Track 1',
    level: 'Beginner',
    flags: [],
    slides_url: null,
    url: BASE + id,
    abstract: `Placeholder abstract for sample talk ${letter}. It mentions kubernetes, security &amp; observability so mock searches find something.`,
    sponsor: false,
    ...extra,
  };
}

const D1 = '2026-11-10';
const D2 = '2026-11-11';

export const MOCK_TALKS: MockTalk[] = [
  talk('A', D1, '09:00', '09:30', { speakers: ['Sample Speaker One', 'Sample Speaker Two'] }),
  talk('B', D1, '09:15', '09:45', { track: 'Sample Track 2', level: 'Advanced', room: 'Sample Room 2' }),
  talk('C', D1, '10:00', '10:30', {
    track: 'Sample Track 3',
    level: 'Any Level',
    flags: ['Slides Attached'],
    slides_url: 'https://example.invalid/mock-slides/c.pdf',
    title: 'Sample talk C with a deliberately long placeholder title that should clamp to two lines on a phone',
  }),
  talk('D', D1, '11:00', '11:30', { flags: ['End User Talk'], room: null }),
  talk('E', D1, '11:00', '11:45', { track: 'Sample Track 2', sponsor: true, level: 'Not specified' }),
  talk('F', D1, '13:30', '14:00', { level: 'Advanced', room: 'Sample Room 3' }),
  talk('G', D1, '14:15', '14:45', { track: 'Sample Track 3', speakers: ['Sample Speaker Three'] }),
  talk('H', D2, '09:00', '09:30', { track: 'Sample Track 2', flags: ['Learning Lounge'] }),
  talk('I', D2, '09:00', '09:45', { level: 'Any Level', room: 'Sample Room 2' }),
  talk('J', D2, '10:30', '11:00', { track: 'Sample Track 3', level: 'Advanced' }),
  talk('K', D2, '14:00', '14:30', { sponsor: true, track: 'Sample Track 2' }),
  talk('L', D2, '15:00', '15:30', { speakers: [], level: 'Beginner', room: 'Sample Room 3' }),
];
