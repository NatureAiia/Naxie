import { useState } from "react";

// Shared "show 10, load more" pattern for long lists — keeps pages short and
// scroll-free by default. Usage:
//   const more = useLoadMore(items);           // 10 per page
//   {more.visible.map(...)}
//   <LoadMoreButton state={more} noun="tasks" />
// The hook resets its window when the item count SHRINKS (a filter change or
// refresh) so a stale "expanded" window never hides the reset list.

export const LOAD_MORE_STEP = 10;

export type LoadMoreState<T> = {
  visible: T[];
  total: number;
  hasMore: boolean;
  remaining: number;
  loadMore: () => void;
  reset: () => void;
};

export function useLoadMore<T>(items: T[], step = LOAD_MORE_STEP): LoadMoreState<T> {
  const [limit, setLimit] = useState(step);
  const [lastCount, setLastCount] = useState(items.length);
  // Shrinking list (filter/search/reset) → collapse back to the first page.
  if (items.length < lastCount && limit !== step) setLimit(step);
  if (items.length !== lastCount) setLastCount(items.length);
  const visible = items.slice(0, limit);
  return {
    visible,
    total: items.length,
    hasMore: items.length > limit,
    remaining: Math.max(0, items.length - limit),
    loadMore: () => setLimit(l => l + step),
    reset: () => setLimit(step),
  };
}

export function LoadMoreButton<T>({ state, noun = "items", className = "" }: { state: LoadMoreState<T>; noun?: string; className?: string }) {
  if (!state.hasMore) return null;
  return (
    <div className={`pt-3 flex justify-center ${className}`}>
      <button
        type="button"
        onClick={state.loadMore}
        className="px-4 py-1.5 text-xs rounded-md border border-ink-700 bg-ink-800/60 text-cream-200 hover:text-cream-50 hover:border-violet-500/40 transition-colors"
      >
        Load {Math.min(LOAD_MORE_STEP, state.remaining)} more {noun} ({state.remaining} remaining)
      </button>
    </div>
  );
}
