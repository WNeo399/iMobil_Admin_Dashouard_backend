# public/widgets/

Built widget bundles live here. Each widget gets its own subdirectory:

```
public/widgets/
└── special-order/
    └── v1.js          ← built IIFE bundle, served at /widget-assets/special-order/v1.js
```

Exceptions — hand-written vanilla JS, no build step, edited right here:
`exploded-diagram/v1.js`, `banner-carousel/v1.js` (the iMobile website
banner carousel; banners are managed on the dashboard's iMobile Website →
Banner page) and `notification/v1.js` (the website popup; iMobile Website →
Notification). Each has a `demo/` page.

`embed-ordering/v1.js` (the ordering widget) and `embed-ordering/viewer3d.js`
(its 3D view — an ES module, also used by the dashboard's Embed Ordering →
3D Diagrams page) are hand-written too. When `viewer3d.js` changes, bump the
`?v=` in `VIEWER_FILE` in both `v1.js` and the dashboard's
`src/views/embedOrdering/diagrams3d.vue` — browsers cache it.

`vendor/three-0.180.0.js` is a pre-built, trimmed three.js for the 3D viewer
(MIT). It is served gzipped (`.js.gz` beside it, picked by app.js) and cached
for a year, so a new build gets a new file name. To rebuild:

```sh
npm install three@0.180.0 esbuild      # in an empty folder, not here
# entry.js — only what viewer3d.js imports:
#   export { WebGLRenderer, Scene, PerspectiveCamera, HemisphereLight, DirectionalLight,
#     PMREMGenerator, Box3, Sphere, Vector2, Vector3, Matrix4, Raycaster, MathUtils,
#     Color, Mesh, ACESFilmicToneMapping, REVISION } from "three";
#   export { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
#   export { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
#   export { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
#   export { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
npx esbuild entry.js --bundle --format=esm --minify --target=es2020 --legal-comments=inline --outfile=three-0.180.0.js
gzip -9 -k three-0.180.0.js
```

The other bundles are produced by the `iMobile_Widget` repo, NOT edited by
hand in this repo. The flow:

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
