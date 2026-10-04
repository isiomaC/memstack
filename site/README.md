# MemStack site

Static landing page for memstack.stalewell.com. No build step: `index.html`,
`styles.css`, `app.js`, plus `llms.txt`, `robots.txt`, `sitemap.xml` and
`_headers` (Cloudflare Pages security headers).

Preview: `python3 -m http.server 4777` in this folder.

Deploy (Cloudflare Pages, `stalewell.com` DNS is on Cloudflare):

    npx wrangler pages deploy . --project-name memstack-site

Then add `memstack.stalewell.com` as a custom domain on the Pages project.
