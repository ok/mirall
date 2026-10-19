# Web links, self-hosted

A `mirall://` link only works where the operating system hands it to Mirall. Pasted into a chat or
an email it is dead for anyone without Mirall installed, and some clients will not even make it
clickable. A **web link** is the same link behind an `https://` page: the page opens Mirall when it
is installed and offers the download when it is not.

Mirall's own links live at `link.mirall.app`. This folder is a sample page that lets you host the
same thing on your own domain: one HTML file, no build step, no dependencies, no server-side code.

## The link forms

| Web link | App link | Payload |
|---|---|---|
| `<base>/space#<code>` | `mirall://join/<code>` | invite code: 64 hex characters (v0) or a base64url JSON envelope (v1) |
| `<base>/relay#<ticket>` | `mirall://relay/<ticket>` | relay invite ticket, 111 z-base-32 characters |
| `<base>/license#a/<code>` | `mirall://license/a/<code>` | an organization's activation code: z-base-32, at most 512 characters, checked and decoded by the app |

The kind is the **last path segment**, the payload is the **URL fragment**. The page swaps the
prefix and nothing else; the payload reaches Mirall verbatim, and Mirall alone decides whether it
is honoured.

## Hosting

1. Copy `index.html` to a web server behind TLS.
2. Rewrite every path to it, so `/space`, `/relay` and `/license` all serve the one file.

Caddy:

```
example.com {
    root * /srv/mirall-links
    try_files {path} /index.html
    file_server
}
```

nginx:

```
location / {
    root /srv/mirall-links;
    try_files $uri /index.html;
}
```

Done. The page also works under a path (`https://example.com/link/space#…`), since only the last
segment matters.

## What the page does

- Shape-checks the payload and, on a desktop browser, navigates once to the app link.
- Losing focus or visibility within 2.5 seconds counts as "opened". A timeout counts as
  "unconfirmed", never "not installed": the download comes first and **Open in Mirall** stays.
  The page never redirects to the download on its own.
- Phones and tablets are told to open the link on a computer.
- A missing or malformed payload shows "this link is incomplete" with the download; an unknown
  kind shows "this link is not recognised".

## Privacy

The payload is in the URL fragment. Browsers never send the fragment to the server, so it does not
reach your access log, a Referer header or a link preview. The page sends `no-referrer`, asks not
to be indexed, makes no network calls and has no form.

## The app side

Mirall accepts a web link from **any host** wherever it accepts the app link: the Join dialog peels
`https://<anything>/space#<code>` down to the code, and the relay dialog does the same for
`/relay#<ticket>`. Only the last path segment and the fragment are read, never the host.

The links Mirall itself generates use `link.mirall.app`. A fleet that wants the app to emit links to
its own page sets `links.baseUrl` in the worker's `settings.json`.
