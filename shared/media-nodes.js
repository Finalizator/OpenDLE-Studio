export const NODE_KINDS = Object.freeze([
  'node3d', 'marker', 'mesh', 'sprite', 'sound', 'projector', 'terminal', 'panel', 'light', 'zone', 'enemy', 'pickup', 'ramp',
]);

export const MEDIA_NODE_DEFAULTS = Object.freeze({
  spritePlane: Object.freeze({ width: 64, height: 64, billboard: false, opacity: 1, doubleSided: true }),
  sound: Object.freeze({ assetId: null, autoplay: true, loop: true, volume: 1, radius: 1024 }),
  projector: Object.freeze({ assetId: null, width: 128, height: 72, opacity: 1, autoplay: true, loop: true, muted: true }),
  terminal: Object.freeze({
    width: 128, height: 96, resolutionWidth: 512, resolutionHeight: 384, mode: 'keypad',
    title: 'Access terminal', code: '1234', variable: 'terminalUnlocked',
    background: '#0c151c', foreground: '#80ffbf', range: 160,
  }),
  mesh: Object.freeze({ shape: 'box', width: 64, height: 64, depth: 64, color: '#8aa2c8', opacity: 1 }),
});

export function mediaNodeKind(entity) {
  return entity?.nodeKind || (entity?.spritePlane ? 'sprite' : entity?.sound ? 'sound' :
    entity?.projector ? 'projector' : entity?.terminal ? 'terminal' : entity?.mesh ? 'mesh' : null);
}

export function entityMediaAssetIds(entity) {
  return [entity?.sound?.assetId, entity?.projector?.assetId].filter(id => typeof id === 'string' && id);
}

export function isNonvisualMediaNode(entity) {
  return entity.type === 'decoration' && !entity.spriteAsset && !entity.modelAsset &&
    Boolean(entity.sound || ['node3d', 'marker', 'sound'].includes(entity.nodeKind));
}
