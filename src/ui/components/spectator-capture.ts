export type SpectatorCaptureAttempt = {
  fullscreen: "succeeded" | "unsupported" | "rejected";
  orientation: "succeeded" | "unsupported" | "rejected" | "skipped";
};

type FullscreenTarget = {
  requestFullscreen?: (options?: FullscreenOptions) => Promise<void>;
};

export type SpectatorOrientation = {
  lock?: (value: "landscape") => Promise<void>;
  unlock?: () => void;
};

type FullscreenDocument = {
  fullscreenElement: unknown;
  exitFullscreen?: () => Promise<void>;
};

/** Privileged browser calls stay in one sequence so the click's user activation is not lost. */
export async function beginSpectatorCapture(
  target: FullscreenTarget,
  orientation: SpectatorOrientation,
): Promise<SpectatorCaptureAttempt> {
  if (!target.requestFullscreen) {
    return { fullscreen: "unsupported", orientation: "skipped" };
  }

  try {
    await target.requestFullscreen();
  } catch {
    return { fullscreen: "rejected", orientation: "skipped" };
  }

  if (!orientation.lock) {
    return { fullscreen: "succeeded", orientation: "unsupported" };
  }

  try {
    await orientation.lock("landscape");
    return { fullscreen: "succeeded", orientation: "succeeded" };
  } catch {
    return { fullscreen: "succeeded", orientation: "rejected" };
  }
}

export function spectatorCapturePresentation(width: number, height: number): "record" | "rotate" {
  return width > height ? "record" : "rotate";
}

export async function endSpectatorCapture(
  captureDocument: FullscreenDocument,
  orientation: SpectatorOrientation,
): Promise<void> {
  try { orientation.unlock?.(); } catch { /* Orientation may never have locked. */ }
  if (!captureDocument.fullscreenElement || !captureDocument.exitFullscreen) return;
  try { await captureDocument.exitFullscreen(); } catch { /* Capture can still close safely. */ }
}
