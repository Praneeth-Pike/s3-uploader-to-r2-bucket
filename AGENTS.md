## Cursor Cloud specific instructions

This is a **Bun + Hono** S3/R2 file upload service with a **Tauri desktop app** frontend. See `README.md` and `CLAUDE.md` for general usage.

### Running the HTTP server (root)

```bash
bun run dev
```

Server starts on `http://localhost:3000`. Hot-reloads on file changes (`--watch`).

### Key endpoints

- `GET /` — returns API info JSON
- `POST /upload` — multipart file upload to S3/R2 (requires `Authorization` header + form fields: `accessKeyId`, `secretAccessKey`, `endpoint`, `bucket`, and file(s))

### Type checking

```bash
bunx tsc --noEmit
```

### Tests

No test files exist currently. Run `bun test` to discover any added later.

### Tauri desktop app (`app/` directory)

The desktop uploader is a Tauri v2 app with a React frontend and Rust backend.

```bash
cd app
bun install
bun run tauri dev
```

- Frontend dev server runs on `http://localhost:1420` (Bun.serve with HMR)
- Rust backend requires: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`
- Rust 1.85+ required (edition2024 support needed by dependencies)
- First `cargo build` takes ~5-10 min due to AWS SDK compilation; subsequent builds are incremental (~5-15s)
- The app stores connection settings in the Tauri app config directory

### Notes

- Bun must be on `$PATH`. The update script installs it to `~/.bun/bin/bun`. If your shell doesn't source `~/.bashrc` automatically, run: `export PATH="$HOME/.bun/bin:$PATH"`.
- The upload endpoints require real S3/R2 credentials to complete a full upload. Without them, the server still starts and validates requests correctly (returns 400/401 for invalid requests).
- The `scripts/upload-folder.ts` CLI requires env vars `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET` (Bun loads `.env` automatically).
- Tauri app DRI3/EGL warnings in headless environments are cosmetic; the app still renders correctly via software rendering.
