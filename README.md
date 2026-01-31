# DeafenSfxSuppression (Vencord custom plugin)

Suppress voice-channel join/leave/stream SFX while **self-deafened** (headphone icon), without muting normal DM/mention notification sounds.

## Install
### Option A: Use this fork (recommended)
1) Clone this repo.
2) Install deps + build + inject:
   - `pnpm install`
   - `pnpm build`
   - `pnpm inject`
3) Restart Discord and enable the plugin in Vencord Settings → Plugins.

### Option B: Add the plugin to an existing Vencord checkout
1) Copy `src/userplugins/deafenSfxSuppression/` from this repo into your Vencord repo at `src/userplugins/deafenSfxSuppression/`.
2) `pnpm install` + `pnpm build` + `pnpm inject`
3) Enable the plugin in Vencord Settings → Plugins.

## Notes
- Custom plugins are not supported in prebuilt Vencord installs; you need a custom build.
