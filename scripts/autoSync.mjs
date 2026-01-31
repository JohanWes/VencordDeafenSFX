/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JohanWes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFileSync } from "child_process";
import { existsSync } from "fs";

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

function isGitOperationInProgress() {
    try {
        const rebaseMerge = runGit(["rev-parse", "--git-path", "rebase-merge"]);
        const rebaseApply = runGit(["rev-parse", "--git-path", "rebase-apply"]);
        const mergeHead = runGit(["rev-parse", "--git-path", "MERGE_HEAD"]);
        const cherryPickHead = runGit(["rev-parse", "--git-path", "CHERRY_PICK_HEAD"]);
        const revertHead = runGit(["rev-parse", "--git-path", "REVERT_HEAD"]);

        return (
            existsSync(rebaseMerge) ||
            existsSync(rebaseApply) ||
            existsSync(mergeHead) ||
            existsSync(cherryPickHead) ||
            existsSync(revertHead)
        );
    } catch {
        return false;
    }
}

function tryAbortRebase() {
    try {
        execFileSync("git", ["rebase", "--abort"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
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

    // Avoid making things worse if a git operation is already in progress.
    if (isGitOperationInProgress()) {
        warn("Git operation in progress (merge/rebase/cherry-pick/revert), skipping git pull");
        process.exit(0);
    }

    info("Pulling latest changes (rebase)...");
    try {
        execFileSync("git", ["pull", "--rebase", "--autostash"], { stdio: "inherit" });
    } catch (error) {
        // If pull/rebase failed (e.g. conflicts), try to abort the rebase to avoid leaving the repo stuck.
        tryAbortRebase();
        throw error;
    }
} catch (error) {
    warn(`Git auto-sync failed, continuing build. (${String(error)})`);
}
