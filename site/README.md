# MemStack site

Static landing page for memstack.stalewell.com. No build step: `index.html`,
`styles.css`, `app.js`, plus `llms.txt`, `robots.txt`, `sitemap.xml` and
`_headers` (Cloudflare Pages security headers).

Preview: `python3 -m http.server 4777` in this folder.

Deploy (Cloudflare Pages, `stalewell.com` DNS is on Cloudflare):

    npx wrangler pages deploy . --project-name memstack-site

Then add `memstack.stalewell.com` as a custom domain on the Pages project.

## Privacy and analytics

The site sets no cookies and self-hosts its fonts (`fonts/`), so no consent
banner is needed. Analytics is Cloudflare Web Analytics (cookieless): enable it
in the Cloudflare dashboard under the Pages project (Metrics > Web Analytics).
The CSP in `_headers` already allows its beacon. If you add any other third
party, update the CSP and `privacy.html` in the same change.
