export interface ThaiCluster {
  prefix: string;
  base: string;
  suffix: string;
  upper: string[];
  tone: string[];
  lower: string[];
}

const THAI_LEADING_VOWELS = new Set(["เ", "แ", "โ", "ใ", "ไ"]);
const THAI_UPPER_MARKS = new Set(["ั", "ิ", "ี", "ึ", "ื", "็", "ํ"]);
const THAI_TONE_MARKS = new Set(["่", "้", "๊", "๋", "์"]);
const THAI_LOWER_MARKS = new Set(["ุ", "ู", "ฺ"]);
const THAI_COMBINING_MARK = /[\u0e31\u0e34-\u0e3a\u0e47-\u0e4e\u0e33]/u;

export function needsThaiClusterLayout(value: string): boolean {
  return THAI_COMBINING_MARK.test(value);
}

function emptyCluster(prefix = "", base = ""): ThaiCluster {
  return { prefix, base, suffix: "", upper: [], tone: [], lower: [] };
}

export function thaiClusters(value: string): ThaiCluster[] {
  const clusters: ThaiCluster[] = [];
  let pendingPrefix = "";
  const current = () => clusters[clusters.length - 1];
  const pushStandalone = (textValue: string) => clusters.push(emptyCluster("", textValue));

  for (const char of value.normalize("NFC")) {
    if (THAI_LEADING_VOWELS.has(char)) {
      pendingPrefix += char;
      continue;
    }

    const target = current();
    if (char === "ำ") {
      if (target?.base) {
        target.upper.push("ํ");
        target.suffix += "า";
      } else {
        pushStandalone(pendingPrefix + char);
        pendingPrefix = "";
      }
      continue;
    }
    if (THAI_UPPER_MARKS.has(char) && target?.base) {
      target.upper.push(char);
      continue;
    }
    if (THAI_TONE_MARKS.has(char) && target?.base) {
      target.tone.push(char);
      continue;
    }
    if (THAI_LOWER_MARKS.has(char) && target?.base) {
      target.lower.push(char);
      continue;
    }

    clusters.push(emptyCluster(pendingPrefix, char));
    pendingPrefix = "";
  }

  if (pendingPrefix) pushStandalone(pendingPrefix);
  return clusters;
}

export function thaiMarkOffsets(cluster: ThaiCluster, size: number): {
  upper: number[];
  tone: number[];
  lower: number[];
} {
  const layerGap = Math.max(1.5, size * 0.18);
  const toneLift = cluster.upper.length > 0 ? Math.max(2.8, size * 0.32) : 0;
  const above = (offset: number) => offset === 0 ? 0 : -offset;
  return {
    upper: cluster.upper.map((_, index) => above(index * layerGap)),
    tone: cluster.tone.map((_, index) => above(toneLift + index * layerGap)),
    lower: cluster.lower.map((_, index) => index * layerGap),
  };
}

/** Sarabun combining glyphs position themselves backward from the pen after the base glyph. */
export function thaiMarkAnchorX(clusterX: number, prefixWidth: number, baseWidth: number): number {
  return clusterX + prefixWidth + baseWidth;
}
