# Geist UI font notice

The application uses the unmodified Latin variable WOFF2 assets shipped with the locked `next@16.4.2` package:

- `node_modules/next/dist/next-devtools/server/font/geist-latin.woff2` (28,356 bytes; SHA-256 `1B5EBFB3A01A97343AC96873E6D59A8CB285C66012B6A1AC509CB2765E995BA8`)
- `node_modules/next/dist/next-devtools/server/font/geist-mono-latin.woff2` (31,288 bytes; SHA-256 `B7AC144B394CBD81052D6397EC0C33397977B1D7E9BC095E744E652A378C6FB3`)

`npm ci` obtains the pinned Next.js package from `package-lock.json`; the build does not fetch these assets from Google Fonts. Next.js `next/font/local` self-hosts the files from the installed package. Keep the lockfile version and integrity entry intact so the source font assets remain reproducible. A Next.js package update that moves or changes these files must update and re-review this notice and its hash checks.

The Geist and Geist Mono typefaces are Copyright 2026 The Geist Project Authors and are distributed under the SIL Open Font License 1.1. The files are not modified by this project. The official source and full license are available at [Vercel's Geist font repository](https://github.com/vercel/geist-font) and its [OFL.txt](https://github.com/vercel/geist-font/blob/main/OFL.txt). The font is bundled with the application and is not sold separately.
