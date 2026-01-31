/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Local
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, StartAt } from "@utils/types";
import { filters, findStore, fluxStores, waitFor } from "@webpack";
import { FluxDispatcher, MediaEngineStore, SelectedChannelStore, VoiceStateStore } from "@webpack/common";

const logger = new Logger("DeafenSfxSuppression");

const settings = definePluginSettings({
    debugLogs: {
        type: OptionType.BOOLEAN,
        description: "Log detected sound IDs/URLs to console (for debugging)",
        default: false,
    },
});

const SOUND_FUNCTIONS = [
    "playSound",
    "playSoundPack",
    "playSoundAtVolume",
    "playSoundWithVolume",
    "playSoundWithVolumeAndPan",
];

const VOICE_SFX_PATTERNS = [
    /user_(join|leave|move)/i,
    /voice_(join|leave|move)/i,
    /stream_(start|stop|end|started|stopped)/i,
    /go_live/i,
    /stage_(start|end|join|leave)/i,
    /viewer_(join|leave)/i,
    /voice_disconnected/i,
    /invited_to_speak/i,
    /activity_(start|end|user_join|user_leave)/i,
];

type PatchedFunction = {
    key: string;
    original: (...args: any[]) => any;
    target: Record<string, any>;
};

const patchedFunctions: PatchedFunction[] = [];
const patchedTargets = new Set<Record<string, any>>();
let isActive = false;

const SUPPRESS_WINDOW_MS = 600;

let suppressUntil = 0;
let lastVoiceChannelId: string | undefined;
let lastMemberCount = 0;
let lastStreamCount = 0;

let originalHtmlMediaPlay: ((...args: any[]) => Promise<void>) | null = null;
let originalAudioBufferStart: ((...args: any[]) => any) | null = null;
let lastWebAudioLog = 0;
const loggedOnce = new Set<string>();
let originalFluxDispatch: ((...args: any[]) => any) | null = null;

type VoiceStateChangeEvent = {
    channelId?: string;
    oldChannelId?: string;
};

function logAvailableSoundStoresOnce() {
    if (!settings.store.debugLogs) return;

    // Populate as much of fluxStores as possible.
    findStore("NotificationSettingsStore");

    const matches: string[] = [];
    for (const name of fluxStores.keys()) {
        if (/sound|audio/i.test(name)) matches.push(name);
    }

    if (matches.length) {
        logger.info("[debug] Available *Sound/Audio* stores:", matches.sort().join(", "));
    } else {
        logger.info("[debug] No *Sound/Audio* stores found in fluxStores map yet.");
    }
}

function normalizeSoundId(soundId: string): string {
    return soundId
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
}

function isSelfDeafened(): boolean {
    try {
        const getSelfDeaf = (MediaEngineStore as any)?.getSelfDeaf;
        if (typeof getSelfDeaf === "function") return Boolean(getSelfDeaf.call(MediaEngineStore));
    } catch {
        // ignore
    }

    try {
        const voiceChannelId = SelectedChannelStore?.getVoiceChannelId?.();
        if (!voiceChannelId) return false;
        const state = VoiceStateStore?.getVoiceStateForChannel?.(voiceChannelId);
        return Boolean(state?.deaf || state?.selfDeaf);
    } catch {
        return false;
    }
}

function shouldSuppressAnySfxNow() {
    return isActive &&
        Date.now() < suppressUntil &&
        isSelfDeafened() &&
        Boolean(SelectedChannelStore?.getVoiceChannelId?.());
}

function getMediaElementSoundId(el: HTMLMediaElement): string | null {
    const src = (el.currentSrc || el.src || "").trim();
    if (!src) return null;
    try {
        const url = new URL(src);
        const file = url.pathname.split("/").pop() ?? "";
        return file.replace(/\.(mp3|ogg|wav)(\?.*)?$/i, "");
    } catch {
        const file = src.split("/").pop() ?? "";
        return file.replace(/\.(mp3|ogg|wav)(\?.*)?$/i, "");
    }
}

function triggerSuppressionWindow(reason: string) {
    if (!isSelfDeafened()) return;
    if (!SelectedChannelStore?.getVoiceChannelId?.()) return;

    suppressUntil = Math.max(suppressUntil, Date.now() + SUPPRESS_WINDOW_MS);
    if (settings.store.debugLogs) logger.info("[debug] Suppressing voice-channel SFX window:", reason);
}

function updateVoiceCountsAndMaybeSuppress() {
    const voiceChannelId = SelectedChannelStore?.getVoiceChannelId?.();
    if (!voiceChannelId) {
        lastVoiceChannelId = undefined;
        lastMemberCount = 0;
        lastStreamCount = 0;
        return;
    }

    const voiceStates = VoiceStateStore?.getVoiceStatesForChannel?.(voiceChannelId);
    if (!voiceStates) return;

    const memberCount = Object.keys(voiceStates).length;
    const streamCount = Object.values(voiceStates).filter(vs => Boolean(vs?.selfStream)).length;

    const channelChanged = lastVoiceChannelId !== voiceChannelId;
    const memberCountChanged = memberCount !== lastMemberCount;
    const streamCountChanged = streamCount !== lastStreamCount;

    lastVoiceChannelId = voiceChannelId;
    lastMemberCount = memberCount;
    lastStreamCount = streamCount;

    if (channelChanged) return;
    if (memberCountChanged) triggerSuppressionWindow("memberCountChanged");
    else if (streamCountChanged) triggerSuppressionWindow("streamCountChanged");
}

function handleSoundModule(module: Record<string, any>) {
    if (!isActive) return;
    if (module == null || (typeof module !== "object" && typeof module !== "function")) return;
    if (patchedTargets.has(module)) return;

    const patchedCount = patchSoundFunctions(module);
    if (patchedCount > 0) {
        patchedTargets.add(module);
    } else {
        logger.warn("No sound functions were patched on resolved module.");
    }
}

function getChannelId(options: unknown): string | undefined {
    if (options == null || typeof options !== "object") return undefined;
    const candidate = (options as any).channelId ??
        (options as any).voiceChannelId ??
        (options as any).currentChannelId ??
        (options as any).targetChannelId;
    return typeof candidate === "string" ? candidate : undefined;
}

function getStringProp(obj: unknown, keys: string[]): string | undefined {
    if (obj == null || typeof obj !== "object") return undefined;
    for (const key of keys) {
        const value = (obj as any)[key];
        if (typeof value === "string") return value;
    }
    return undefined;
}

function getSoundId(soundArg: unknown, optionsArg: unknown): string | undefined {
    if (typeof soundArg === "string") return soundArg;
    const commonKeys = ["sound", "soundId", "soundName", "name", "id", "key", "event", "type"];

    const direct = getStringProp(soundArg, commonKeys) ?? getStringProp(optionsArg, commonKeys);
    if (direct) return direct;

    const nestedSound = (soundArg as any)?.sound ?? (optionsArg as any)?.sound;
    const nested = getStringProp(nestedSound, commonKeys);
    if (nested) return nested;

    return;
}

function isVoiceChannelSfxSoundId(soundId: string): boolean {
    const normalized = normalizeSoundId(soundId);
    return VOICE_SFX_PATTERNS.some(pattern => pattern.test(soundId) || pattern.test(normalized));
}

function shouldSuppress(soundArg: unknown, optionsArg: unknown): boolean {
    if (!isSelfDeafened()) return false;
    const voiceChannelId = SelectedChannelStore?.getVoiceChannelId?.();
    if (!voiceChannelId) return false;

    const optionsChannelId = getChannelId(optionsArg);
    const soundArgChannelId = getChannelId(soundArg);
    if ((optionsChannelId && optionsChannelId === voiceChannelId) || (soundArgChannelId && soundArgChannelId === voiceChannelId)) return true;

    const soundId = getSoundId(soundArg, optionsArg);
    if (!soundId) return false;

    return isVoiceChannelSfxSoundId(soundId);
}

function patchSoundFunctions(target: Record<string, any>) {
    let patchedCount = 0;
    for (const key of SOUND_FUNCTIONS) {
        const original = target[key];
        if (typeof original !== "function") continue;

        target[key] = function (...args: any[]) {
            if (settings.store.debugLogs && isSelfDeafened() && SelectedChannelStore?.getVoiceChannelId?.()) {
                const soundId = getSoundId(args[0], args[1]);
                if (soundId) {
                    const logKey = `soundModule:${key}:${soundId}`;
                    if (!loggedOnce.has(logKey) && loggedOnce.size < 250) {
                        loggedOnce.add(logKey);
                        logger.info(`[debug] SoundModule.${key} called:`, soundId, args[1] ?? null);
                    }
                } else {
                    const logKey = `soundModule:${key}:unknownArgs`;
                    if (!loggedOnce.has(logKey) && loggedOnce.size < 250) {
                        loggedOnce.add(logKey);
                        const a0 = args[0];
                        const a1 = args[1];
                        logger.info(
                            `[debug] SoundModule.${key} called (no soundId extracted). Keys:`,
                            a0 && typeof a0 === "object" ? Object.keys(a0) : typeof a0,
                            a1 && typeof a1 === "object" ? Object.keys(a1) : typeof a1
                        );
                    }
                }
            }
            if (shouldSuppress(args[0], args[1])) return;
            return original.apply(this, args);
        };

        patchedFunctions.push({ key, original, target });
        patchedCount++;
    }
    return patchedCount;
}

function patchNotificationSettingsStore(store: Record<string, any>) {
    const original = store.isSoundDisabled;
    if (typeof original !== "function") return;

    store.isSoundDisabled = function (sound: string) {
        if (settings.store.debugLogs && isSelfDeafened() && SelectedChannelStore?.getVoiceChannelId?.()) {
            const logKey = `isSoundDisabled:${sound}`;
            if (!loggedOnce.has(logKey) && loggedOnce.size < 250) {
                loggedOnce.add(logKey);
                logger.info("[debug] NotificationSettingsStore.isSoundDisabled:", sound);
            }
        }
        if (isActive && isSelfDeafened() && SelectedChannelStore?.getVoiceChannelId?.() && isVoiceChannelSfxSoundId(sound)) {
            return true;
        }
        return original.call(this, sound);
    };

    patchedFunctions.push({ key: "isSoundDisabled", original, target: store });
}

function patchLowLevelAudioPlayback() {
    if (originalHtmlMediaPlay == null) {
        originalHtmlMediaPlay = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function (...args: any[]) {
            try {
                if (isActive && isSelfDeafened() && SelectedChannelStore?.getVoiceChannelId?.()) {
                    const soundId = getMediaElementSoundId(this);
                    if (soundId && isVoiceChannelSfxSoundId(soundId)) {
                        if (settings.store.debugLogs) logger.info("[debug] Blocked HTMLMediaElement.play:", soundId, this.currentSrc || this.src);
                        return Promise.resolve();
                    }
                    if (settings.store.debugLogs && soundId) {
                        const logKey = `htmlMediaPlay:${soundId}`;
                        if (!loggedOnce.has(logKey) && loggedOnce.size < 250) {
                            loggedOnce.add(logKey);
                            logger.info("[debug] HTMLMediaElement.play:", soundId, this.currentSrc || this.src);
                        }
                    }
                }
            } catch {
                // ignore
            }

            if (shouldSuppressAnySfxNow()) {
                if (settings.store.debugLogs) {
                    const logKey = "blocked:htmlMedia:window";
                    if (!loggedOnce.has(logKey) && loggedOnce.size < 250) {
                        loggedOnce.add(logKey);
                        logger.info("[debug] Blocked HTMLMediaElement.play due to suppression window");
                    }
                }
                return Promise.resolve();
            }
            // @ts-ignore - DOM typing is fine, we want to preserve `this`
            return originalHtmlMediaPlay!.apply(this, args);
        };
    }

    const maybeAbs: any = (globalThis as any).AudioBufferSourceNode;
    if (maybeAbs?.prototype?.start && originalAudioBufferStart == null) {
        originalAudioBufferStart = maybeAbs.prototype.start;
        maybeAbs.prototype.start = function (...args: any[]) {
            const inVoiceDeaf = isActive && isSelfDeafened() && SelectedChannelStore?.getVoiceChannelId?.();
            if (inVoiceDeaf && settings.store.debugLogs && Date.now() - lastWebAudioLog > 250) {
                lastWebAudioLog = Date.now();
                logger.info("[debug] AudioBufferSourceNode.start (WebAudio) called", new Error().stack);
            }
            if (shouldSuppressAnySfxNow()) {
                if (settings.store.debugLogs) {
                    const logKey = "blocked:webAudio:window";
                    if (!loggedOnce.has(logKey) && loggedOnce.size < 250) {
                        loggedOnce.add(logKey);
                        logger.info("[debug] Blocked AudioBufferSourceNode.start due to suppression window");
                    }
                }
                return;
            }
            return originalAudioBufferStart!.apply(this, args);
        };
    }
}

function unpatchLowLevelAudioPlayback() {
    if (originalHtmlMediaPlay != null) {
        HTMLMediaElement.prototype.play = originalHtmlMediaPlay;
        originalHtmlMediaPlay = null;
    }

    const maybeAbs: any = (globalThis as any).AudioBufferSourceNode;
    if (maybeAbs?.prototype?.start && originalAudioBufferStart != null) {
        maybeAbs.prototype.start = originalAudioBufferStart;
        originalAudioBufferStart = null;
    }
}

function patchFluxDispatch() {
    if (originalFluxDispatch != null) return;
    if (typeof FluxDispatcher?.dispatch !== "function") return;

    originalFluxDispatch = FluxDispatcher.dispatch;
    FluxDispatcher.dispatch = function (payload: any) {
        try {
            const type = payload?.type;

            if (isActive && isSelfDeafened() && SelectedChannelStore?.getVoiceChannelId?.() && typeof type === "string") {
                if (
                    type === "VOICE_STATE_UPDATES" ||
                    type === "STREAMING_UPDATE" ||
                    type === "STREAM_CREATE" ||
                    type === "STREAM_START" ||
                    type === "STREAM_STOP" ||
                    type === "STREAM_DELETE" ||
                    type === "RTC_CONNECTION_CLIENT_CONNECT" ||
                    type === "RTC_CONNECTION_CLIENT_DISCONNECT"
                ) {
                    triggerSuppressionWindow(type);
                }
            }
        } catch {
            // ignore
        }

        return originalFluxDispatch!.call(this, payload);
    };
}

function unpatchFluxDispatch() {
    if (originalFluxDispatch == null) return;
    FluxDispatcher.dispatch = originalFluxDispatch;
    originalFluxDispatch = null;
}

function unpatchAll() {
    for (const { key, original, target } of patchedFunctions) {
        target[key] = original;
    }
    patchedFunctions.length = 0;
}

export default definePlugin({
    name: "DeafenSfxSuppression",
    description: "Suppress voice-channel SFX while self-deafened (keeps regular notifications)",
    authors: [{ name: "Local", id: 0n }],
    settings,
    startAt: StartAt.WebpackReady,
    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceStateChangeEvent[]; }) {
            if (!isActive) return;
            if (!isSelfDeafened()) return;

            const voiceChannelId = SelectedChannelStore?.getVoiceChannelId?.();
            if (!voiceChannelId) return;

            for (const state of voiceStates) {
                if (state?.channelId === voiceChannelId || state?.oldChannelId === voiceChannelId) {
                    triggerSuppressionWindow("VOICE_STATE_UPDATES");
                    break;
                }
            }

            updateVoiceCountsAndMaybeSuppress();
        },

        STREAMING_UPDATE() {
            if (!isActive) return;
            if (!isSelfDeafened()) return;
            if (!SelectedChannelStore?.getVoiceChannelId?.()) return;
            triggerSuppressionWindow("STREAMING_UPDATE");
            updateVoiceCountsAndMaybeSuppress();
        },
    },
    start() {
        try {
            isActive = true;
            logAvailableSoundStoresOnce();
            updateVoiceCountsAndMaybeSuppress();
            patchFluxDispatch();
            patchLowLevelAudioPlayback();
            waitFor(["playSound"], m => handleSoundModule(m as Record<string, any>));
            waitFor(["playSoundPack"], m => handleSoundModule(m as Record<string, any>));
            waitFor(filters.byStoreName("NotificationSettingsStore"), m => patchNotificationSettingsStore(m as Record<string, any>));
        } catch (error) {
            logger.error("Failed to start DeafenSfxSuppression:", error);
        }
    },
    stop() {
        isActive = false;
        unpatchAll();
        patchedTargets.clear();
        unpatchLowLevelAudioPlayback();
        unpatchFluxDispatch();
        loggedOnce.clear();
    },
});
