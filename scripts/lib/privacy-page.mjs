// The privacy policy of the Conference Caddie apps, published on the GitHub Pages site as
// privacy.html by scripts/pages-landing.mjs. Google Play and the App Store link to it
// (docs/store/PLAY.md, docs/store/APP_STORE.md).
//
// Every statement here was checked against the code of this repository on the date below: the
// native apps (native/), the tier 3 server they use by default (server/, scripts/es-setup-people.mjs)
// and the contracts (docs/contracts/). When the apps or the server change what they send, store or
// keep, change this page in the same pull request and move EFFECTIVE_DATE.
//
// The sections on the official deployment (OFFICIAL_SERVER_HOST and "Service providers") describe
// the maintainer's own hosting. A fork that publishes this page for its own server must rewrite
// them; scripts/test/pages-privacy.test.mjs fails when OFFICIAL_SERVER_HOST no longer matches the
// default backend compiled into the apps (Defaults.BACKEND in native/shared, CaddieCore.kt).
//
// Like the landing page, the page holds no script, no form and no external resource; its
// Content-Security-Policy forbids them.

export const EFFECTIVE_DATE = '12 November 2026';
export const OFFICIAL_SERVER_HOST = 'conference-caddie-265846417372.us-west1.run.app';
export const OFFICIAL_REPO_URL = 'https://github.com/KurtLehnardt/conferenceCaddie';

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// The repository's https address on GitHub, without a trailing slash. Throws on anything else.
export function normaliseRepoUrl(value) {
  const raw = String(value ?? '').trim();
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('The repository URL is not a valid URL.');
  }
  const path = u.pathname.replace(/\/+$/, '');
  if (u.protocol !== 'https:' || u.host !== 'github.com' || u.username || u.password || u.search || u.hash || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path)) {
    throw new Error('The repository URL must be https://github.com/<owner>/<repository>.');
  }
  return `https://github.com${path}`;
}

/**
 * The privacy page. siteUrl is the Pages site's address (its home page link); repoUrl the
 * repository on GitHub, whose issues are the contact.
 */
export function privacyPage(siteUrl, repoUrl = OFFICIAL_REPO_URL) {
  const home = escapeHtml(siteUrl);
  const repo = escapeHtml(normaliseRepoUrl(repoUrl));
  const issues = `${repo}/issues`;
  const server = escapeHtml(OFFICIAL_SERVER_HOST);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="strict-origin-when-cross-origin" />
    <title>Privacy policy · Conference Caddie</title>
    <style>
      :root { color-scheme: light dark; --fg: #1d2330; --muted: #5a6273; --bg: #f5f6f8; --link: #1f5fbf; --rule: #dde1e8; }
      @media (prefers-color-scheme: dark) { :root { --fg: #e8eaef; --muted: #a3aab8; --bg: #14171d; --link: #8db7ff; --rule: #2c323d; } }
      body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
      main { max-width: 42rem; margin: 0 auto; padding: 2.5rem 1rem 3rem; overflow-wrap: anywhere; }
      h1 { font-size: 1.6rem; margin: 0 0 0.25rem; }
      h2 { font-size: 1.15rem; margin: 2rem 0 0.5rem; padding-top: 1rem; border-top: 1px solid var(--rule); }
      p, ul { margin: 0 0 0.85rem; }
      ul { padding-left: 1.25rem; }
      li { margin-bottom: 0.35rem; }
      a { color: var(--link); }
      .small { color: var(--muted); font-size: 0.9rem; }
      nav.toc { font-size: 0.95rem; }
      nav.toc ul { columns: 2 14rem; }
      nav.toc li { margin-bottom: 0.15rem; }
    </style>
  </head>
  <body>
    <main>
      <p class="small"><a href="${home}">Conference Caddie</a></p>
      <h1>Privacy policy</h1>
      <p class="small">Effective ${EFFECTIVE_DATE}</p>

      <p>Conference Caddie helps you find talks and people to talk to at Linux Foundation conferences. It is open-source software (<a href="${repo}">source code</a>). This policy covers the Conference Caddie apps for Android and iOS and the server they use by default. It explains what the apps send, what that server stores, how long it keeps it and how you can delete it. "We" means the maintainer of the Conference Caddie project, who runs that server.</p>

      <nav class="toc" aria-label="Contents">
        <ul>
          <li><a href="#summary">In short</a></li>
          <li><a href="#talks">Using the app without a profile</a></li>
          <li><a href="#profile">Your profile</a></li>
          <li><a href="#presence">Being around and your position</a></li>
          <li><a href="#meets">Asking to talk shop</a></li>
          <li><a href="#safety">Reports and blocks</a></li>
          <li><a href="#notifications">Notifications</a></li>
          <li><a href="#bluetooth">Bluetooth</a></li>
          <li><a href="#retention">How long data is kept</a></li>
          <li><a href="#delete">Deleting your data</a></li>
          <li><a href="#phone">What stays on your phone</a></li>
          <li><a href="#never">What we never collect</a></li>
          <li><a href="#providers">Service providers</a></li>
          <li><a href="#other-servers">Other servers</a></li>
          <li><a href="#security">Security</a></li>
          <li><a href="#children">Children</a></li>
          <li><a href="#rights">Your choices and rights</a></li>
          <li><a href="#changes">Changes</a></li>
          <li><a href="#contact">Contact</a></li>
        </ul>
      </nav>

      <h2 id="summary">In short</h2>
      <ul>
        <li>There is no account to sign in to. The app never asks for your email address or phone number.</li>
        <li>There are no ads, no analytics, no crash reporting and no tracking. We do not sell your data or share it with anyone for advertising.</li>
        <li>Searching talks, the suggestions in For you and your schedule work on your phone and stay there.</li>
        <li>The people features are optional. If you make a profile, the server keeps it only until the end of the conference, and Delete my profile removes it at once.</li>
        <li>Your position is sent only if you turn it on, only while the app is open, and it is deleted when your presence ends. Other attendees never see it.</li>
      </ul>

      <h2 id="talks">Using the app without a profile</h2>
      <p>The app downloads the list of conferences and each conference's talk data (titles, abstracts, speakers and times, taken from the conference's public schedule) from the server and from the project's GitHub Pages site. These requests carry nothing that identifies you, although, like every request on the internet, they show your IP address to the service that answers them.</p>
      <p>Searching talks, the suggestions in For you, the topics you want to learn, the talks you mark as Interested and your schedule are worked out and kept on your phone. They are not sent to us.</p>
      <p>When you open a talk, the app asks the server how many people share their profile for it. The request names only the conference and the talk; the server answers with a number and keeps nothing.</p>
      <p>If you import a schedule file (a calendar or spreadsheet export), the app sends the file's contents to the server, which reads them once to find the matching talks and sends back the matches. The server does not store or log the file.</p>

      <h2 id="profile">Your profile</h2>
      <p>To find people to talk to, you can make a profile for a conference. It holds a display name, which is required and can be any name you choose, and, if you want, a few sentences about you, your interests, your expertise, the topics you want to learn or could speak about, a LinkedIn profile address, a note on how to reach you, and the talks for which you share your profile.</p>
      <p>When you first save a profile, the app creates a random identifier and a random secret on your phone for that server. The server stores your profile under that identifier with only a one-way hash of the secret, which lets it recognise your phone without an account.</p>
      <p>To match people by meaning, the server turns the text of your profile into numbers (an embedding) with a model that runs inside its own database service, not with an outside AI service.</p>
      <p>While you are visible at a conference, other attendees who are also visible there can see your profile and may be matched with you. If you share your profile for a talk, people who share theirs for the same talk can see it as well. People who are neither visible nor sharing see nothing.</p>
      <p>Turning visibility off removes your profile from the server for that conference, unless you still share it for a talk; Stop sharing for all talks then removes it too.</p>

      <h2 id="presence">Being around and your position</h2>
      <p>While your profile is visible, you can tell other attendees that you are around: the room or area of the venue you are in and, if you like, a short line on how to spot you. Your presence lasts 60 minutes, or until the end of the conference day if you choose that, and never past the end of the conference. You can end it at any time.</p>
      <p>If you also turn on Use my position, the app sends your device's position with your presence. It does this only if you allowed precise location, only while the app is open, and at most about once every 30 seconds. The app never asks for location access in the background. The server rounds the position to about a metre, discards it if it is less accurate than 200 metres, and stores it, with the centre of the grid square of roughly 100 metres around it, only for as long as your presence lasts. When you end your presence, the position is deleted at once; when your presence runs out, the position is no longer used and is deleted at the server's next cleanup (see <a href="#retention">How long data is kept</a>).</p>
      <p>Nobody else ever sees your position. Other attendees see only a rough band, such as near or at the venue. If you and another person agree to meet, each of you sees the distance to the other, in steps of 10 metres, and a direction, and only while that meeting lasts.</p>

      <h2 id="meets">Asking to talk shop</h2>
      <p>You can ask another visible attendee to talk shop. A request can carry a short note, a meeting point and a line on how to spot you, and only the two of you can see it. A request lasts 15 minutes and an accepted meeting 20 minutes. When it ends, its note, meeting point and spot line are erased, and the rest of the record (the two random identifiers, its state and its times) is deleted once it has expired. A declined request is kept, without its text, for up to two days, so that the Not now pause it sets can be applied.</p>
      <p>The app has no chat and keeps no conversations.</p>

      <h2 id="safety">Reports and blocks</h2>
      <p>You can report a profile, a spot line or a request to talk shop, choosing one of a fixed list of reasons; there is no free text. A report stores the random identifiers of the person who reports and of the person reported, what was reported, the reason and the time. Reports from two different people hide what was reported. Reports are kept after either profile is deleted, so that deleting and re-creating a profile does not undo a hide, until we review and remove them.</p>
      <p>When you block someone, the server stores both random identifiers until the end of the conference, and the two of you no longer see each other.</p>

      <h2 id="notifications">Notifications</h2>
      <p>On Android, while you are visible, your presence is on, the conference is under way and you allow notifications, the app checks about every 15 minutes in the background whether someone you might want to meet is around. The check uses your profile's random identifier and stores nothing on the server. The notification is made on your phone and names nobody.</p>
      <p>Our server does not send push notifications through Apple, Google or web browsers. If a server offers them, the iOS app registers for them only after you make your profile visible, and that server keeps the push token until the end of the conference.</p>

      <h2 id="bluetooth">Bluetooth</h2>
      <p>The published apps do not use Bluetooth. Finding people nearby by Bluetooth is still being tested and is switched off in the published apps; the Android app does not even request a Bluetooth permission.</p>

      <h2 id="retention">How long data is kept</h2>
      <p>Data that has run out is no longer shown to anyone or used. The server deletes it at its next cleanup, which runs whenever the server starts and then every hour while it runs.</p>
      <ul>
        <li><strong>Your profile and its embedding:</strong> until 23:59:59 on the conference's last day, in the conference's time zone.</li>
        <li><strong>Your presence and position:</strong> until your presence runs out, after 60 minutes or at the end of the conference day. If you end your presence yourself, they are deleted at once.</li>
        <li><strong>Requests to talk shop:</strong> minutes, as described above; a declined request up to two days, without its text.</li>
        <li><strong>Blocks:</strong> until the end of the conference.</li>
        <li><strong>Reports:</strong> until we review and remove them.</li>
        <li><strong>Request logs:</strong> 30 days, as described under <a href="#providers">Service providers</a>.</li>
      </ul>
      <p>Our hosting providers keep backups of their own, such as the automatic snapshots of our database service, so deleted data can remain in a backup for a limited time under their retention rules. A copy that we make by hand, for example during maintenance, is not covered by the automatic deletion and is deleted by hand.</p>

      <h2 id="delete">Deleting your data</h2>
      <p>In the app, open People, then your profile, and tap Delete my profile. This deletes your profile from your phone and from the server the app is connected to, for every conference on that server, together with your presence, your requests to talk shop, your push registrations and the people you blocked. It takes effect at once. If your phone is offline, the app tries again until the server confirms the deletion.</p>
      <p>What remains: reports you made or that were made about you, until we review them; blocks that other people made of you, until the end of the conference; and, on your phone, the people you met and the talks you marked. Uninstalling the app, or clearing its storage, removes everything the app keeps on your phone.</p>
      <p>If you no longer have the app, your profile is still deleted automatically after the conference ends. To have it deleted sooner, or for any other request about your data, <a href="#contact">contact us</a> with the conference and the display name you used.</p>

      <h2 id="phone">What stays on your phone</h2>
      <p>The app keeps its data in its own private storage: the talk data, your settings, the talks you marked, your schedule and, if you use the people features, a copy of your profile and the people you met. The secret that identifies your phone to the server is encrypted with a key held by Android's keystore, or kept in the iOS keychain. On Android, the app's data is excluded from cloud backups and from transfers to a new device. On iOS, the people data and the secret are excluded from backups, while your settings and the talks you marked can be part of your device's backup.</p>

      <h2 id="never">What we never collect</h2>
      <ul>
        <li>Your email address, phone number, contacts, calendars or photos.</li>
        <li>Your position in the background, or at any time unless you turn it on.</li>
        <li>Advertising identifiers or the hardware identifiers of your phone. The only identifier is the random one the app makes for each server.</li>
        <li>Usage analytics, crash reports or diagnostics. The library that runs the search model on your phone (ONNX Runtime) has its telemetry switched off.</li>
      </ul>

      <h2 id="providers">Service providers and where data is processed</h2>
      <p>Our server (${server}) runs on Google Cloud Run in Google's us-west1 region (Oregon, United States). Its database is Elastic Cloud, hosted on Google Cloud in the same region. The public talk data is also served by GitHub Pages. These providers process data only to run the service for us.</p>
      <p>Google Cloud records every request to the server in its request logs, with the IP address, the app's or browser's identification string (user agent) and the address requested, and keeps those logs for 30 days. The server's own log lines hold only the method, the path, the response status and the time taken. To limit abuse, the server keeps IP addresses in memory for at most about an hour to count requests; they are never written to storage. GitHub receives the IP address of each request for talk data, under GitHub's own privacy statement.</p>
      <p>Your data is processed in the United States. If you use the people features from another country, your profile is transferred to the United States.</p>

      <h2 id="other-servers">Other servers</h2>
      <p>Anyone can run a server for Conference Caddie. If you connect the app to another server, in Settings under Server or by opening a server link, the app sends the same data to that server instead, and its operator decides where it is hosted and how long its logs are kept. The app names the server and asks you to confirm before it switches.</p>

      <h2 id="security">Security</h2>
      <p>All traffic between the app and the server is encrypted with HTTPS. The server stores only a hash of your phone's secret. Our providers encrypt stored data at rest, as their documentation describes.</p>

      <h2 id="children">Children</h2>
      <p>Conference Caddie is made for people attending professional conferences. It is not directed at children, and we do not knowingly collect data from children.</p>

      <h2 id="rights">Your choices and rights</h2>
      <p>Everything in your profile except the display name is optional, and you can change or delete your profile in the app at any time. You can also ask us what we hold about you, ask us to correct or delete it, or object to how we use it. Because the server knows you only by a random identifier, tell us the conference and the display name you used so that we can find your profile.</p>

      <h2 id="changes">Changes to this policy</h2>
      <p>We update this page when the apps or the server change what they collect or how long they keep it. The date at the top shows the latest change, and the full history of the page is in the project's <a href="${repo}">source repository</a>.</p>

      <h2 id="contact">Contact</h2>
      <p>For questions or requests about privacy, open an issue at <a href="${issues}">${issues.replace(/^https:\/\//, '')}</a>. Issues there are public, so do not put personal details in the issue: title it "Privacy request", and we will reply with a private way to send them.</p>
    </main>
  </body>
</html>
`;
}
