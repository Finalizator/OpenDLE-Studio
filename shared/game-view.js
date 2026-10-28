export function gameView(hud, settings, width, height, hudVisible = true) {
  const blocks = settings.viewSize ?? 10;
  const statusbar = hudVisible && blocks < 11;
  const scale = hud.scaleMode === 'stretch' ? height / hud.height : Math.min(width / hud.width, height / hud.height);
  const inset = statusbar ? Math.round((hud.reserveBottom || 0) * scale) : 0;
  const fraction = Math.min(blocks, 10) / 10;
  const viewWidth = Math.max(1, Math.floor(width * fraction));
  const viewHeight = Math.max(1, Math.floor((height - inset) * fraction));
  return { x: Math.floor((width - viewWidth) / 2), y: Math.floor((height - inset - viewHeight) / 2),
    width: viewWidth, height: viewHeight, inset, statusbar };
}

/**
 * Whether the game view needs a scissor rectangle at all.
 *
 * A view that covers the whole drawing buffer must *not* turn the scissor test on: Three
 * skips a scissor rectangle that matches the screen and leaves the GL context untouched,
 * so enabling the test would keep whatever box the context last held (the renderer's
 * construction size) and clip the world to a corner of a resized preview. `scale` is the
 * low-detail divisor applied to the drawn width.
 */
export function viewNeedsScissor(view, bufferWidth, bufferHeight, scale = 1) {
  const width = view.width / scale;
  return view.x / scale > 0 || view.y > 0 || width < bufferWidth - .5 || view.height < bufferHeight - .5;
}

/**
 * Whether the classic status bar is hidden by the current screen size.
 *
 * Screen size 11 reserves no room for the bar in `gameView` and the HUD view hides
 * every `statusbar` element, so the preview asks this before telling the player why
 * the bar is gone and before offering the control that brings it back.
 */
export function statusBarHidden(hud, settings) {
  return (settings?.viewSize ?? 10) === 11 && (hud?.elements || []).some(element => element.statusbar);
}
