# DeafenSfxSuppression (Vencord custom plugin)

Suppress voice-channel join/leave/stream SFX while **self-deafened** (headphone icon), without muting normal DM/mention notification sounds.

## Install
1) Install/build Vencord from source.
2) Copy this folder into your Vencord repo:
   - from: `deafenSfxSuppression/`
   - to:   `Vencord/src/userplugins/deafenSfxSuppression/`
3) Build + inject:
   - `pnpm build`
   - `pnpm inject`
4) Enable the plugin in Vencord Settings → Plugins.

## Notes
- Custom plugins are not supported in prebuilt Vencord installs; you need a custom build.
