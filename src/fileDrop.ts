import type { PhysicalPosition } from "@tauri-apps/api/dpi";

import { IS_WINDOWS } from "./platform";

/**
 * Tauri's drop position is physical on Windows (ScreenToClient), but already
 * logical on macOS (AppKit) and Linux (GTK). DOM hit tests use CSS pixels.
 */
export const dropPoint = (position: PhysicalPosition): { x: number; y: number } =>
  IS_WINDOWS ? position.toLogical(window.devicePixelRatio) : position;
