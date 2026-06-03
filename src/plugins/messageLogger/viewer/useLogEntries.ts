/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { getAllEntries, subscribeToChanges } from "@plugins/messageLogger/persistence";
import { PersistedMessage } from "@plugins/messageLogger/types";
import { useAwaiter } from "@utils/react";
import { ChannelStore, useEffect, useMemo, useReducer } from "@webpack/common";

export type ViewerScope = "channel" | "guild" | "global";

export interface UseLogEntriesArgs {
    scope: ViewerScope;
    channelId?: string;
    guildId?: string;
}

/**
 * Snapshot the persisted log, reactive to capture/remove/purge events. Returns
 * the entries pre-filtered by scope (channel/guild/global). The modal layers
 * tab/search/author/sort filters on top of this in render.
 */
export function useLogEntries({ scope, channelId, guildId }: UseLogEntriesArgs): PersistedMessage[] {
    const [signal, bump] = useReducer((x: number) => x + 1, 0);

    useEffect(() => {
        const unsubscribe = subscribeToChanges(bump);
        return unsubscribe;
    }, []);

    const [entries] = useAwaiter(() => getAllEntries(), {
        fallbackValue: [] as PersistedMessage[],
        deps: [signal],
    });

    return useMemo(() => {
        if (scope === "channel" && channelId) return entries.filter(e => e.channelId === channelId);
        // Fall back to deriving the guild from the entry's channelId when the stored
        // guildId is missing. Deleted entries persisted before the write-side fix (and
        // any whose channel was uncached at flush time) have guildId:undefined; without
        // this they'd never match a server scope. See LogEntryRow's channel resolution.
        if (scope === "guild" && guildId) return entries.filter(e => (e.guildId ?? ChannelStore.getChannel(e.channelId)?.guild_id) === guildId);
        return entries;
    }, [entries, scope, channelId, guildId]);
}
