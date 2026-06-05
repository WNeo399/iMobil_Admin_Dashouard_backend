# public/widgets/

Built widget bundles live here. Each widget gets its own subdirectory:

```
public/widgets/
└── special-order/
    └── v1.js          ← built IIFE bundle, served at /widget-assets/special-order/v1.js
```

These files are produced by the `iMobile_Widget` repo, NOT edited by hand
in this repo. The flow:

```sh
# from the iMobile_Widget repo:
npm run build:to-backend         # builds every widget + copies dist/ into here
# then back in this repo:
git add public/widgets
git commit -m "ship widget X update"
git push                         # Railway picks up + redeploys
```

The Express app serves this directory at `/widget-assets/` via `app.use`
in `app.js`, with `Access-Control-Allow-Origin: *` so embedding sites can
load the script cross-origin.

Once we migrate widget hosting to Cloudflare Pages, this whole directory
and the `/widget-assets/` mount can be deleted — Cloudflare will serve
the bundles directly from the `iMobile_Widget` repo's `main` branch.
