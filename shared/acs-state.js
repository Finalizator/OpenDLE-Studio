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
