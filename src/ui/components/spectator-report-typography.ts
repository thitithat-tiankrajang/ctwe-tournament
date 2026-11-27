function fontAtSize(element: Element) {
  const { fontStyle, fontWeight, fontFamily } = getComputedStyle(element);
  return (size: number) => `${fontStyle} ${fontWeight} ${size}px ${fontFamily}`;
}

function inlineMargins(element: Element): number {
  const { marginInlineStart, marginInlineEnd } = getComputedStyle(element);
  return parseFloat(marginInlineStart) + parseFloat(marginInlineEnd);
}

/** Grow the code and player text together, keeping the base size available for wrapped text. */
export function fitSpectatorReportText(table: HTMLTableElement, context: CanvasRenderingContext2D) {
  const names = table.querySelectorAll<HTMLElement>(".vrep-person .nm");
  const code = names[0]?.previousElementSibling;
  if (!code) return;

  const tokens = getComputedStyle(table);
  const min = parseFloat(tokens.getPropertyValue("--vrep-code-min"));
  const max = parseFloat(tokens.fontSize);
  const gap = parseFloat(tokens.getPropertyValue("--vrep-text-size-gap"));
  const codeFont = fontAtSize(code);
  const nameFont = fontAtSize(names[0]);
  const codeMargins = inlineMargins(code);
  const lines = Array.from(names, name => {
    const badge = name.nextElementSibling;
    const badgeWidth = badge ? badge.getBoundingClientRect().width + inlineMargins(badge) : 0;
    return {
      code: name.previousElementSibling?.textContent ?? "",
      text: name.textContent ?? "",
      width: (name.parentElement?.getBoundingClientRect().width ?? 0) - codeMargins - badgeWidth,
    };
  });
  const schoolSelector = table.querySelector("td.vrep-school")?.getClientRects().length ? "td.vrep-school" : ".vrep-person .l2";
  const schools = table.querySelectorAll(schoolSelector);
  const schoolFont = schools.length ? fontAtSize(schools[0]) : null;
  const schoolWidths = Array.from(schools, school => {
    const style = getComputedStyle(school);
    const width = school.getBoundingClientRect().width - parseFloat(style.paddingInlineStart) - parseFloat(style.paddingInlineEnd)
      - parseFloat(style.borderInlineStartWidth) - parseFloat(style.borderInlineEndWidth);
    return { text: school.textContent ?? "", width };
  });

  const fits = (codeSize: number) => {
    const textSize = codeSize - gap;
    context.font = codeFont(codeSize);
    const room = lines.map(row => row.width - context.measureText(row.code).width);
    context.font = nameFont(textSize);
    if (lines.some((row, index) => context.measureText(row.text).width > room[index])) return false;
    if (!schoolFont) return true;
    context.font = schoolFont(textSize);
    return schoolWidths.every(row => context.measureText(row.text).width <= row.width);
  };

  let low = Math.round(min * 10);
  let high = Math.floor(max * 10);
  while (low < high) {
    const size = Math.ceil((low + high) / 2);
    if (fits(size / 10)) low = size;
    else high = size - 1;
  }
  table.style.setProperty("--vrep-code-size", `${low / 10}px`);
}
