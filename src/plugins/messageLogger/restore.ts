/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { Message } from "@vencord/discord-types";
import { MessageCache, MessageStore } from "@webpack/common";

import { getCachedBlobUrl } from "./attachmentCache";
import { deserialize, deserializeEditHistory, getEntriesForChannel } from "./persistence";
import { PersistedMessage } from "./types";

const logger = new Logger("MessageLogger");

const DISCORD_EPOCH = 1_420_070_400_000n;

/** Snowflake ID → ms epoch. Pure function. */
function snowflakeToMs(id: string): number {
    return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

/** Pick the chronologically-earliest snowflake from an array using BigInt compare. */
function minSnowflake(ids: string[]): string | null {
    if (ids.length === 0) return null;
    let minId = ids[0];
    let minBig = BigInt(minId);
    for (let i = 1; i < ids.length; i++) {
        const big = BigInt(ids[i]);
        if (big < minBig) { minBig = big; minId = ids[i]; }
    }
    return minId;
}

/**
 * Build a real Message instance from a persisted entry, using a constructor we
 * grabbed from a live message in the same channel.
 */
async function restoreMessageInstance(entry: PersistedMessage, Ctor: any): Promise<Message> {
    const plain = deserialize(entry.message);
    if (entry.editHistory) plain.editHistory = deserializeEditHistory(entry.editHistory);
    if (entry.firstEditTimestamp != null) plain.firstEditTimestamp = new Date(entry.firstEditTimestamp);
    plain.deleted = entry.deleted;
    if (Array.isArray(plain.attachments)) {
        plain.attachments = await Promise.all(plain.attachments.map(async (a: any) => {
            if (typeof a?.id !== "string") return { ...a, deleted: entry.deleted };
            const blobUrl = await getCachedBlobUrl(a.id);
            if (!blobUrl) return { ...a, deleted: entry.deleted };
            // Fragment guard: Discord's image renderer appends `?format=webp&width=...&height=...`
            // to attachment URLs for resizing. Blob URLs key on the path (minus fragment), so a bare
            // `blob:.../<uuid>` becomes `blob:.../<uuid>?format=...` and fails ERR_FILE_NOT_FOUND.
            // With a `#mlcache` fragment, string-concat appends after the `#`, becoming
            // `blob:.../<uuid>#mlcache?format=...`. Browser treats everything after `#` as fragment;
            // path is still `<uuid>` so blob-store lookup resolves.
            const guarded = `${blobUrl}#mlcache`;
            return { ...a, url: guarded, proxy_url: guarded, deleted: entry.deleted };
        }));
    }
    return new Ctor(plain);
}

/**
 * Apply persisted entries for a channel to its live `MessageCache`.
 * Idempotent — re-running on the same channel is a no-op (all writes are
 * conditional on the entry not already being present in the cache).
 *
 * Returns true if the channel's messages were loaded and restore actually ran
 * (whether or not anything needed injecting); false if it bailed early because
 * the channel's messages weren't loaded yet. Callers use this so an early bail
 * does NOT consume the double-apply dedup slot — otherwise an empty-on-arrival
 * CHANNEL_SELECT would suppress the later LOAD_MESSAGES_SUCCESS that has data.
 */
export async function applyEntriesToChannel(channelId: string): Promise<boolean> {
    try {
        const channelMessages = MessageStore.getMessages(channelId) as any;
        if (!channelMessages || channelMessages.loadingMore) return false;
        const liveArr = (channelMessages._array as any[]) ?? [];
        if (liveArr.length === 0) return false;

        const oldestId = minSnowflake(liveArr.map(m => m.id));
        if (!oldestId) return false;
        const since = snowflakeToMs(oldestId);

        const entries = await getEntriesForChannel(channelId, { since });
        if (entries.length === 0) return true;

        const Ctor = liveArr[0].constructor;
        let cache = (MessageCache as any).getOrCreate(channelId);
        let mutated = false;

        for (const entry of entries) {
            const live = (channelMessages._map as Record<string, Message> | undefined)?.[entry.id];
            if (live) {
                cache = cache.update(entry.id, (m: any) => {
                    if (m.editHistory && m.editHistory.length > 0) return m;
                    const history = deserializeEditHistory(entry.editHistory);
                    let next = m;
                    if (history) next = next.set("editHistory", history);
                    if (entry.firstEditTimestamp != null) {
                        next = next.set("firstEditTimestamp", new Date(entry.firstEditTimestamp));
                    }
                    return next;
                });
                mutated = true;
            } else if (entry.deleted) {
                if ((cache as any).has?.(entry.id)) continue;
                const instance = await restoreMessageInstance(entry, Ctor);
                cache = cache.receiveMessage(instance).update(entry.id, (m: any) => m
                    .set("deleted", true)
                    .set("attachments", (m.attachments ?? []).map((a: any) => ({ ...a, deleted: true }))));
                mutated = true;
            }
        }

        if (mutated) {
            (MessageCache as any).commit(cache);
            (MessageStore as any).emitChange();
        }
        return true;
    } catch (e) {
        logger.error("applyEntriesToChannel failed for", channelId, e);
        return false;
    }
}

// ---- flux handlers ----------------------------------------------------------

const recentlyApplied = new Map<string, number>();
const RECENT_THRESHOLD_MS = 250;

/** Read-only window check — no side effects. */
function isRecentlyApplied(channelId: string): boolean {
    const last = recentlyApplied.get(channelId);
    return last != null && Date.now() - last < RECENT_THRESHOLD_MS;
}

/**
 * Record a successful apply for the dedup window. Called only AFTER
 * applyEntriesToChannel actually ran with messages loaded, so an early-return
 * (messages not loaded yet) leaves the slot free for the subsequent
 * LOAD_MESSAGES_SUCCESS that does have data.
 */
function markApplied(channelId: string): void {
    const now = Date.now();
    recentlyApplied.set(channelId, now);
    // Opportunistic eviction: when the map grows large, drop entries past the
    // dedup window. Power users browse hundreds of channels per session.
    if (recentlyApplied.size > 256) {
        for (const [k, t] of recentlyApplied) {
            if (now - t > RECENT_THRESHOLD_MS) recentlyApplied.delete(k);
        }
    }
}

/** Flux handler — exported for the plugin's `flux:` block. */
export async function onLoadMessagesSuccess({ channelId, messages }: { channelId: string; messages: any[]; }): Promise<void> {
    if (!messages || messages.length === 0) return;
    if (isRecentlyApplied(channelId)) return;
    if (await applyEntriesToChannel(channelId)) markApplied(channelId);
}

/** Flux handler — exported for the plugin's `flux:` block. */
export async function onChannelSelect({ channelId }: { channelId: string | null; }): Promise<void> {
    if (!channelId) return;
    if (isRecentlyApplied(channelId)) return;
    if (await applyEntriesToChannel(channelId)) markApplied(channelId);
}
