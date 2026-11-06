/**
 * A level's ACS variables, reachable from a rule.
 *
 * A decompiled script does not run in the interpreter any more, but its variables are still
 * the level's: another script that was not decompiled, a saved game and a `TagWait` all read
 * the same numbers. So a rule addresses that store (`setAcsVariable`, `acsVariable`,
 * `acsvar("map", 2)` in an expression) instead of keeping a copy that would drift.
 */

/** The store a scope names, or null when the level has no compiled scripts. */
export function acsVariableStore(state, scope = 'map', module = 0) {
  const vm = state?.scripts?.vm;
  if (!vm) return null;
  if (scope === 'world') return vm.worldVars || null;
  if (scope === 'global') return vm.globalVars || null;
  return vm.mapVars?.[Number(module) || 0] || null;
}

/** One variable's value; zero when the level has no such store, which reads as "unset". */
export function readAcsVariable(state, scope = 'map', index = 0, module = 0) {
  const store = acsVariableStore(state, scope, module);
  return store ? store[Number(index) || 0] | 0 : 0;
}

/**
 * A variable that holds a string-table index, read back as the name it stands for.
 *
 * ACS passes flats and textures as strings, and a script may keep one in a variable —
 * `ChangeFloor(tag, flatVar)` — so a rule asks for the name the same way the interpreter did:
 * through the same table, at run time, with `acsflat("map", 12)`.
 */
export function readAcsString(state, scope = 'map', index = 0, module = 0) {
  const vm = state?.scripts?.vm;
  if (!vm) return '';
  const behaviour = vm.program?.modules?.[Number(module) || 0]?.module || vm.module;
  const slot = readAcsVariable(state, scope, index, module);
  if (!behaviour) return '';
  // An interned string (from `Str` handling) lives in the pool, not the module's table.
  if ((slot >>> 0) >= 0x40000000) return vm.pool?.[slot & 0xffff] ?? '';
  return behaviour.strings?.[slot & 0xffff] ?? '';
}
