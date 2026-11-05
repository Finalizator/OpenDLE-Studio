import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBehavior, createAcsVm, startScript, tickAcs, PCODE_NAMES } from '../shared/acs.js';

const P = Object.fromEntries(PCODE_NAMES.map((name, code) => [name, code]));

/**
 * Minimal ACS assembler for tests, mirroring the helper in test/acs.test.js:
 * a header, a code block and the named chunks ACC emits. Addresses are byte
 * offsets from the start of the lump, matching ZDoom's `Data` base pointer.
 */
function behavior({ code = [], scripts = [], strings = [], mapVars = [] }) {
  const bytes = [];
  const word = value => bytes.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
  const chars = text => bytes.push(...[...text].map(char => char.charCodeAt(0)));
  const align = () => { while (bytes.length % 4) bytes.push(0); };
  bytes.push(0x41, 0x43, 0x53, 0x00); // "ACS\0"
  const dirofsAt = bytes.length;
  word(0);
  for (const byte of code) bytes.push(byte & 0xff);
  const chunkStart = bytes.length;
  const chunk = (id, data) => { chars(id); word(data.length); bytes.push(...data); };
  const scriptData = [];
  for (const script of scripts) {
    scriptData.push(script.number & 0xff, (script.number >> 8) & 0xff, script.type | 0, script.args | 0);
    const address = script.address;
    scriptData.push(address & 0xff, (address >> 8) & 0xff, (address >> 16) & 0xff, (address >> 24) & 0xff);
  }
  chunk('SPTR', scriptData);
  if (mapVars.length) chunk('MINI', [...wordBytes(0), ...mapVars.flatMap(wordBytes)]);
  if (strings.length) {
    const offsets = [];
    let cursor = 12 + 4 * strings.length;
    const body = [];
    for (const text of strings) {
      offsets.push(cursor);
      body.push(...[...text].map(char => char.charCodeAt(0)), 0);
      cursor += text.length + 1;
    }
    chunk('STRL', [0, 0, 0, 0, ...wordBytes(strings.length), 0, 0, 0, 0, ...offsets.flatMap(wordBytes), ...body]);
  }
  align();
  word(chunkStart);
  chars('ACSe');
  bytes.push(0, 0, 0, 0, 0, 0, 0, 0);
  const dirofs = bytes.length - 8;
  bytes[dirofsAt] = dirofs & 0xff;
  bytes[dirofsAt + 1] = (dirofs >> 8) & 0xff;
  bytes[dirofsAt + 2] = (dirofs >> 16) & 0xff;
  bytes[dirofsAt + 3] = (dirofs >> 24) & 0xff;
  return new Uint8Array(bytes);
}

function wordBytes(value) {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

/** Code emitter; addresses are absolute byte offsets from the lump start. */
function emitter() {
  const code = [];
  const at = () => 8 + code.length;
  const api = {
    code,
    at,
    byte: value => { code.push(value & 0xff); return api; },
    word: value => { code.push(...wordBytes(value)); return api; },
    ins: (name, ...operands) => {
      if (P[name] >= 240) code.push(0xf0, P[name] - 240);
      else code.push(P[name]);
      for (const operand of operands) code.push(...wordBytes(operand));
      return api;
    },
    push: value => { code.push(P.PUSHNUMBER); code.push(...wordBytes(value)); return api; },
    pushBytes: (...values) => {
      code.push(values.length === 1 ? P.PUSHBYTE : P[`PUSH${values.length}BYTES`]);
      code.push(...values);
      return api;
    },
  };
  return api;
}

test('ACS: array division by zero terminates the script instead of silently writing 0', () => {
  const asm = emitter();
  asm.push(0).push(10).ins('ASSIGNSCRIPTARRAY').byte(0)   // scriptArray[0][0] = 10
    .push(0).push(0).ins('DIVSCRIPTARRAY').byte(0)        // scriptArray[0][0] /= 0
    .push(1).ins('ASSIGNMAPVAR').byte(0)                  // only reached if the VM keeps running
    .ins('BEGINPRINT').push(0).ins('PRINTSTRING').ins('ENDPRINT').ins('TERMINATE');
  const parsed = parseBehavior(behavior({ code: asm.code,
    scripts: [{ number: 1, type: 0, args: 0, address: 8 }], strings: ['survived'] }));
  const printed = [];
  const vm = createAcsVm(parsed, { print: text => printed.push(text) });
  startScript(vm, 1);
  tickAcs(vm);
  assert.match(vm.errors.join(' '), /division by zero/, 'the zero divisor is reported');
  assert.equal(vm.mapVars[0][0], 0, 'the instruction after the division never runs');
  assert.deepEqual(printed, [], 'the script is terminated before it can print');
});

test('ACS: SetResultValue pops its operand, leaving the script stack balanced', () => {
  const asm = emitter();
  asm.push(42).ins('SETRESULTVALUE').ins('TERMINATE');
  const parsed = parseBehavior(behavior({ code: asm.code, scripts: [{ number: 1, type: 0, args: 0, address: 8 }] }));
  const vm = createAcsVm(parsed);
  const result = startScript(vm, 1, { wantResult: true });
  assert.equal(result, 42);
  const script = vm.active.find(entry => entry.number === 1);
  assert.equal(script.sp, 0, 'the operand of SetResultValue is popped, as ZDoom falls through to DROP');
  assert.deepEqual(script.stack.slice(0, script.sp), [], 'no leaked operand remains on the logical stack');
});

test('ACS: GetSectorFloorZ takes integer map coordinates, not fixed point', () => {
  const asm = emitter();
  asm.pushBytes(0, 64, 32).ins('GETSECTORFLOORZ').ins('ASSIGNMAPVAR').byte(0).ins('TERMINATE');
  const parsed = parseBehavior(behavior({ code: asm.code, scripts: [{ number: 1, type: 0, args: 0, address: 8 }] }));
  const calls = [];
  const vm = createAcsVm(parsed, {
    getSectorZ: (tag, x, y, ceiling) => { calls.push([tag, x, y, ceiling]); return 160 * 65536; },
  });
  startScript(vm, 1);
  tickAcs(vm);
  assert.deepEqual(calls[0], [0, 64, 32, false], 'x and y reach the host as map units');
  assert.equal(vm.mapVars[0][0], 160 * 65536, 'the floor height comes back as fixed point');
});
