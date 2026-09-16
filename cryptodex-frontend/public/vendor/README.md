# public/vendor — third-party assets, served from this origin

Everything in here used to be loaded from a public CDN by `pages/_app.tsx`:

| asset | was | why it moved |
|---|---|---|
| `fontawesome/` | cdnjs.cloudflare.com, font-awesome 6.4.2 | unpinned, no SRI |
| `bootstrap/bootstrap.min.css` | cdn.jsdelivr.net, bootstrap 5.3.1 | unpinned, no SRI |
| `fonts/` | fonts.googleapis.com + fonts.gstatic.com (Inter, Space Grotesk) | unpinned, and *invisible*: it was an `@import` on line 1 of `styles/globals.css`, so nothing in the document shell named it |

A fourth CDN, code.jquery.com (jquery 1.11.2, `strategy="beforeInteractive"`),
was removed outright rather than moved: nothing in this codebase uses jQuery.

The fonts entry is the one worth remembering. Three of these were `<link>`/
`<Script>` tags in `pages/_app.tsx` and a grep found them. The fourth was a
stylesheet `@import`, which no inspection of the shell can see - it only exists
once a browser parses the CSS. It was found by loading `/2fa` in a real
Chromium and recording every request (`e2e/twofa-third-party.spec.ts`), which is
why that spec exists alongside the source-level jest guards.

**Why not Subresource Integrity instead?** SRI pins the bytes. It does not
remove the origin. Every page load still tells cdnjs and jsDelivr who is
reading the page and when, and if the origin is unreachable the page renders
unstyled. The page that mattered most here — `/2fa` — renders the TOTP secret
and the full `otpauth://` URI (secret plus account email) into the DOM while
those stylesheets are attached to it. This is a local, single-machine paper
exchange: there is no cache-hit or bandwidth argument on the other side of that
trade.

## Provenance — how to regenerate

These are byte-for-byte copies of files from npm packages declared in
`package.json`, not downloads. To refresh after a version bump:

```sh
# Font Awesome 6.4.2 (the version the cdnjs URL asked for)
cp node_modules/@fortawesome/fontawesome-free/css/all.min.css   public/vendor/fontawesome/css/
cp node_modules/@fortawesome/fontawesome-free/webfonts/*        public/vendor/fontawesome/webfonts/
cp node_modules/@fortawesome/fontawesome-free/LICENSE.txt       public/vendor/fontawesome/

# Bootstrap (5.3.3; the CDN pinned 5.3.1, a patch behind)
node -e "const f=require('fs');f.writeFileSync('public/vendor/bootstrap/bootstrap.min.css',f.readFileSync('node_modules/bootstrap/dist/css/bootstrap.min.css','utf8').replace(/\/\*# sourceMappingURL=[^*]*\*\//g,''))"
cp node_modules/bootstrap/LICENSE public/vendor/bootstrap/
```

### Inter / Space Grotesk

`fonts/fonts.css` is the Google Fonts `css2` response for
`Inter:wght@300;400;500;600;700;800` + `Space Grotesk:wght@400;500;600;700`
(`display=swap`), verbatim, with every `fonts.gstatic.com` URL rewritten to a
sibling file. Both families are ONE VARIABLE FONT PER UNICODE SUBSET, which is
why ten `.woff2` files cover all fifty-four `@font-face` rules. To refresh:
fetch that css2 URL with a modern browser User-Agent (an old one is answered
with `.ttf` instead of `.woff2`), download each `url()` it names, and rewrite
the URLs to `/vendor/fonts/<family>-<subset>.woff2`. All subsets are kept -
dropping the non-latin ones would silently fall back to a system font for any
name or ticker outside latin.

The rules are attached with a `<link>` in `_app.tsx`, not re-`@import`ed from
`globals.css`: an `@import` cannot be discovered until `globals.css` itself has
been downloaded and parsed, and then blocks rendering on a second round trip.

---

`all.min.css` references its webfonts as `../webfonts/…`, which is why the
`css/` and `webfonts/` directory layout has to be preserved. The
`sourceMappingURL` comment is stripped from the bootstrap copy because the map
is not shipped and browsers would 404 on it.

Neither file fetches anything off-origin: the only absolute URLs left in them
are the SVG XML namespace (`http://www.w3.org/2000/svg`, never requested) and
license comments. `tests/…/twofa-no-third-party-assets.test.tsx` asserts that.

Licences ship alongside each package, as both require.
