/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JohanWes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFileSync } from "child_process";

function runGit(args) {
    return execFileSync("git", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function warn(msg) {
    console.warn(`[autoSync] ${msg}`);
}

function info(msg) {
    console.log(`[autoSync] ${msg}`);
}

function shouldSkip() {
    if (process.env.CI) return "CI=true";
    if ((process.env.VENCORD_AUTO_SYNC ?? "1") === "0") return "VENCORD_AUTO_SYNC=0";
    return null;
}

try {
    const skipReason = shouldSkip();
    if (skipReason) {
        info(`Skipping (${skipReason})`);
        process.exit(0);
    }

    try {
        runGit(["rev-parse", "--is-inside-work-tree"]);
    } catch {
        info("Not a git repo, skipping");
        process.exit(0);
    }

    const status = runGit(["status", "--porcelain"]);
    if (status.length) {
        warn("Working tree not clean, skipping git pull");
        process.exit(0);
    }

    const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch !== "main") {
        warn(`Not on 'main' (on '${branch}'), skipping git pull`);
        process.exit(0);
    }

    info("Pulling latest changes (ff-only)...");
    execFileSync("git", ["pull", "--ff-only"], { stdio: "inherit" });
} catch (error) {
    warn(`Git auto-sync failed, continuing build. (${String(error)})`);
}
