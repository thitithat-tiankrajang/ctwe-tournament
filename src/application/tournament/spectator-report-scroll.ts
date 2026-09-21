export interface PendingReportScroll {
  id: number;
  cardId: string;
  scrollY: number;
}

/**
 * Owns one document-scroll restoration until it either succeeds or its history entry is left.
 *
 * Effect cleanup is deliberately not an ownership transition. React may clean an effect up before
 * its scheduled frame runs (Strict Mode and an adjacent route render both do this); consuming the
 * target during effect setup made that ordinary lifecycle permanently lose the saved position.
 */
export function createReportScrollOwner() {
  let sequence = 0;
  let pending: PendingReportScroll | null = null;

  return {
    stage(cardId: string, scrollY: number): PendingReportScroll {
      pending = { id: ++sequence, cardId, scrollY };
      return pending;
    },
    targetFor(cardId: string): PendingReportScroll | null {
      return pending?.cardId === cardId ? pending : null;
    },
    isCurrent(id: number): boolean {
      return pending?.id === id;
    },
    complete(id: number): boolean {
      if (pending?.id !== id) return false;
      pending = null;
      return true;
    },
    cancel(): void {
      pending = null;
    },
  };
}

export type ReportScrollOwner = ReturnType<typeof createReportScrollOwner>;

/** Execute one post-layout attempt without surrendering ownership on a failed or stale attempt. */
export function attemptReportScroll(
  owner: ReportScrollOwner,
  target: PendingReportScroll,
  maxScroll: number,
  scrollTo: (scrollY: number) => void,
  readScrollY: () => number,
): "stale" | "pending" | "complete" {
  if (!owner.isCurrent(target.id)) return "stale";
  const expected = Math.min(target.scrollY, Math.max(0, maxScroll));
  scrollTo(target.scrollY);
  if (Math.abs(readScrollY() - expected) > 1) return "pending";
  owner.complete(target.id);
  return "complete";
}
