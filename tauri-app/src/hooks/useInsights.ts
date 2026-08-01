// client/src/hooks/useInsights.ts
// Hook for auto-triggering background agent insights on new messages

import { useEffect, useRef, useCallback } from 'react';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { api } from '../lib/api';

interface UseInsightsOptions {
    enabled?: boolean;
    debounceMs?: number;
}

/**
 * Hook that auto-triggers background agent insights when new messages arrive.
 * Uses debouncing to prevent excessive API calls during rapid message updates.
 */
export function useInsights(
    workspaceId: string | null,
    messageCount: number,
    options: UseInsightsOptions = {}
) {
    const { enabled = true, debounceMs = 2000 } = options;

    const addInsights = useWorkspaceStore(state => state.addInsights);
    const setLoadingInsights = useWorkspaceStore(state => state.setLoadingInsights);

    // Track previous message count to detect new messages
    const prevMessageCountRef = useRef(messageCount);
    const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const lastTriggeredRef = useRef<number>(0);

    const triggerInsightGeneration = useCallback(async () => {
        if (!workspaceId) return;

        const now = Date.now();
        // Minimum cooldown of 5 seconds between triggers
        if (now - lastTriggeredRef.current < 5000) {
            console.log('[useInsights] Skipping - cooldown period');
            return;
        }
        lastTriggeredRef.current = now;

        try {
            setLoadingInsights(true);
            console.log('[useInsights] Triggering background agent analysis...');

            const response = await api.post(`/workspaces/${workspaceId}/insights`, {
                enableLocal: true,
                enableGlobal: true,
            });

            const data = response.data;

            if (data.insights && data.insights.length > 0) {
                console.log(`[useInsights] Received ${data.insights.length} insights`);
                addInsights(data.insights);
            } else {
                console.log('[useInsights] No insights generated');
            }
        } catch (error) {
            console.error('[useInsights] Error generating insights:', error);
        } finally {
            setLoadingInsights(false);
        }
    }, [workspaceId, addInsights, setLoadingInsights]);

    // Monitor message count changes and trigger with debounce
    useEffect(() => {
        if (!enabled || !workspaceId) {
            prevMessageCountRef.current = messageCount;
            return;
        }

        // Detect if new messages were added (not initial load)
        const hasNewMessages = messageCount > prevMessageCountRef.current && prevMessageCountRef.current > 0;
        prevMessageCountRef.current = messageCount;

        if (hasNewMessages) {
            console.log('[useInsights] New messages detected, scheduling insight generation...');

            // Clear any pending debounce
            if (debounceTimeoutRef.current) {
                clearTimeout(debounceTimeoutRef.current);
            }

            // Schedule insight generation after debounce period
            debounceTimeoutRef.current = setTimeout(() => {
                triggerInsightGeneration();
            }, debounceMs);
        }

        // Cleanup
        return () => {
            if (debounceTimeoutRef.current) {
                clearTimeout(debounceTimeoutRef.current);
            }
        };
    }, [enabled, workspaceId, messageCount, debounceMs, triggerInsightGeneration]);

    // Return trigger function for manual invocation
    return {
        triggerInsightGeneration,
    };
}

export default useInsights;
