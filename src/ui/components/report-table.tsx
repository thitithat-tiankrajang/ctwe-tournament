"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * A public report split into two tables: a visible column header that stays with the page while it
 * scrolls, and a semantic table containing the rows.
 *
 * The split keeps the visible header outside the data table's flow so the browser can keep one
 * compact column header sticky while the report itself uses the page's natural vertical scroll.
 * There is deliberately no nested report scroller: on a phone, the page owns the gesture and the
 * surrounding tournament context can leave the viewport.
 *
 * The price of splitting is that two tables lay themselves out independently, so the header is made
 * the width authority: it lays out `auto`, sized by its own labels, which are the widest thing in
 * every narrow column (ผลต่างสะสม is wider than any difference it will ever hold). Its measured
 * column widths are then copied onto the body, which lays out `fixed` and wraps rather than clips.
 *
 * Measured, not hard-coded: these are Thai labels at a clamped size, and a number that is right at
 * 375px is wrong at 320px and wrong again the moment the webfont lands.
 *
 * The body keeps a real <thead> of its own, visually hidden. Two visible header rows would be read
 * twice; none at all would leave every cell with no column to belong to, which is the WCAG 1.3.1
 * failure this product's table tests exist to prevent.
 */
export function ReportTable({ label, head, className = "", children }: {
  label: string;
  /** The header row — rendered visibly outside the data table, and again, hidden, inside it. */
  head: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const headTable = useRef<HTMLTableElement>(null);
  const [widths, setWidths] = useState<number[]>([]);

  // Percentages, not pixels: if the body box ever renders a classic scrollbar it is a little
  // narrower than the header, and pixel columns would then overflow it instead of scaling.
  const measure = useCallback(() => {
    const table = headTable.current;
    const cells = table?.querySelectorAll("th");
    const total = table?.getBoundingClientRect().width ?? 0;
    if (!cells || total === 0) return;
    const next = [...cells].map((cell) => (cell.getBoundingClientRect().width / total) * 100);
    setWidths((now) =>
      now.length === next.length && now.every((width, i) => Math.abs(width - next[i]) < 0.05) ? now : next);
  }, []);

  // After every render, because the header reflows when the rows around it change; and on resize,
  // because nothing re-renders when the viewport does.
  useLayoutEffect(measure);
  useEffect(() => {
    const table = headTable.current;
    if (!table) return;
    const observer = new ResizeObserver(measure);
    observer.observe(table);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <div className={`spectator-report ${className}`.trim()}>
      <div className="spectator-report__head">
        <table ref={headTable} aria-hidden="true" className="spectator-table">
          <thead>{head}</thead>
        </table>
      </div>
      <div className="spectator-report__body">
        <table aria-label={label} className="spectator-table spectator-table--fixed">
          {widths.length > 0 && (
            <colgroup>
              {widths.map((width, index) => <col key={index} style={{ width: `${width}%` }} />)}
            </colgroup>
          )}
          <thead className="spectator-report__head-sr">{head}</thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  );
}
