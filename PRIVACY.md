# Privacy Notice

_Effective: August 16, 2026_

This notice explains what Seat Watcher processes in local and hosted modes. Seat
Watcher is an independent project and is not part of BookMyShow. BookMyShow's
own privacy policy applies separately when you visit its website.

## Data Seat Watcher processes

A watch can contain:

- the BookMyShow seat-layout URL supplied by the user;
- selected row letters, requested seat count, contiguous-seat preference, and an optional label;
- movie, theater, date, time, seat numbers, availability, and check status read from the watched page; and
- timestamps, errors, check duration, and match status.

Seat Watcher does not ask for or store your BookMyShow password or payment-card
details. Do not enter credentials, payment details, or other sensitive personal
information into watch labels or URLs.

## Local mode

By default, the server associates watches with the local development user and
stores them in `watches.json` on the computer running the app. That file remains
until watches are deleted in the app or the file is deleted by the operator. It
is excluded from this Git repository.

Local server monitoring sends page requests to BookMyShow through Playwright
from the computer running the server. BookMyShow and the network provider can
observe normal request metadata such as the public IP address and browser
headers.

## Hosted mode

When authentication and Cosmos DB are configured, the app can process:

- the authenticated user identifier and display name supplied by the hosting platform;
- the watch data listed above, partitioned by user identifier; and
- browser-companion status, including connection time, heartbeat, version, errors, and check summaries.

Azure and the hosting operator may process ordinary infrastructure metadata,
including IP addresses, request headers, timestamps, and diagnostic logs, under
their own policies. Watch data remains until the user deletes it or the operator
removes it. Signing out alone does not necessarily delete stored watch data.

## Browser companion

The Edge/Chrome companion stores the following in browser local storage:

- the Seat Watcher app URL and pairing token;
- pairing and last-run timestamps;
- recent errors and check summaries; and
- notification state used to avoid duplicate alerts.

The pairing token grants access to the paired Seat Watcher watchlist. Treat it
as private, do not paste it into an issue or chat, and disconnect the extension
if it is exposed.

For each watch, the companion can open the supplied BookMyShow URL in an
inactive tab, set the BookMyShow region cookie, click the seat-selection prompt,
read the rendered seat map, send the normalized result to the paired Seat
Watcher server, and close the tab. It does not send the page's full HTML to Seat
Watcher. Native notifications may display movie, venue, row, and seat details on
the device lock screen depending on operating-system settings.

The extension requests `alarms`, `cookies`, `notifications`, `scripting`,
`storage`, and `tabs` permissions, access to BookMyShow pages, and access to the
paired Seat Watcher origin. Review those permissions before installation.

## Why data is used

The data is used only to maintain the user's watchlist, check the requested seat
layouts, calculate availability matches, show status, pair the browser
companion, and deliver alerts. The project code does not sell watch data or use
it for advertising.

## Other services

- BookMyShow receives requests when a watched page is opened.
- Azure receives hosted app traffic and stores data when the Azure deployment is used.
- Google Fonts may receive a browser request when the web interface loads its fonts.
- GitHub receives traffic when users follow repository, legal, or privacy links.

Each provider has its own terms and privacy practices.

## Your choices

You can delete individual watches or clear the watchlist in the app, disconnect
the companion to remove its pairing state, remove the extension, clear browser
storage, or stop the server. For an account-wide hosted-data request, contact
the operator privately through the
[madhus1025 GitHub profile](https://github.com/madhus1025). Do not put sensitive
personal information in a public GitHub issue.

## Security and changes

No system is completely secure. Keep dependencies and the extension current,
protect the pairing token, and do not expose a local server directly to the
internet without authentication. This notice may be updated when data handling
or hosting changes; the effective date above will be revised.
