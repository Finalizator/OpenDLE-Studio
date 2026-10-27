// Which way the panorama sky looks. The editor derives heading and pitch from its
// free camera; the playtest follows the player, whose pitch is part of the runtime
// state. Keeping this here means the values are tested instead of being locals of a
// render-loop block that a refactor can silently drop.

export function skyView({ editor = false, direction = { x: 0, y: 0, z: 1 }, player = {} } = {}) {
  if (editor) return { heading: Math.atan2(direction.z, direction.x), pitch: Math.asin(Math.max(-1, Math.min(1, direction.y || 0))) };
  return { heading: Number(player.angle) || 0, pitch: Number(player.pitch) || 0 };
}
