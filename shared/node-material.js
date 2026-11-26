// Cloning a node material, with the one flag three leaves behind.
//
// `NodeMaterial.copy` copies the properties it can walk with `for…in`, and `alphaTest` is an
// accessor on `Material.prototype` — non-enumerable — so it is never one of them. A cloned sprite
// material therefore came back with `alphaTest: 0`, and every transparent pixel of the picture was
// drawn instead as black: three r185 turned each monster into an opaque rectangle with the sprite
// inside it. A classic material copies `alphaTest` by hand and is unaffected, so only node
// materials have to come through here.

/** A copy of a node material that keeps its alpha test, which `clone()` alone drops. */
export function cloneNodeMaterial(source) {
  const copy = source.clone();
  copy.alphaTest = source.alphaTest;
  return copy;
}
