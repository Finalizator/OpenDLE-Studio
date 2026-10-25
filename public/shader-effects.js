import * as TSL from 'three/tsl';
import GLSLDecoder from 'three/addons/transpiler/GLSLDecoder.js';
import TSLEncoder from 'three/addons/transpiler/TSLEncoder.js';
import Transpiler from 'three/addons/transpiler/Transpiler.js';
import { parseShaderSource } from '../shared/shader-language.js';

function compileExpression(node, inputs) {
  if (node.isNumber) return TSL.float(Number(node.value.replace(/[fF]$/, '')));
  if (node.isAccessor) return node.property.split('.').reduce((value, name, index) => index ? value[name] : inputs[name], null);
  if (node.isSwizzle) return compileExpression(node.expression, inputs)[node.swizzle];
  if (node.isOperator) {
    const left = compileExpression(node.left, inputs), right = compileExpression(node.right, inputs);
    return left[{ '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'remainder' }[node.type]](right);
  }
  if (node.isUnary) {
    const value = compileExpression(node.expression, inputs);
    return node.type === '-' ? value.negate() : value;
  }
  return TSL[node.name](...node.params.map(argument => compileExpression(argument, inputs)));
}

export function compileGLSLEffect(shader) {
  const defaults = shader.uniforms ?? {};
  const { body } = parseShaderSource(shader.source, defaults);
  const prelude = Object.keys(defaults).map(name => `uniform float ${name};`).join('\n');
  const source = `${prelude}\n${shader.source}`;
  const encoder = new TSLEncoder(); encoder.iife = true; encoder.reference = true;
  // Keep the official transpilation available for diagnostics; build the same TSL
  // graph directly from its validated GLSL AST without evaluating JavaScript/CSP exceptions.
  const generated = new Transpiler(new GLSLDecoder(), encoder).parse(source);
  const uniforms = Object.fromEntries(Object.entries(defaults).map(([name, value]) => [name, { value }]));
  const references = Object.fromEntries(Object.entries(uniforms).map(([name, entry]) => [name, TSL.reference('value', 'float', entry)]));
  const effect = TSL.Fn(([color, uv, time]) => {
    const inputs = { ...references, color, uv, time };
    for (const statement of body) {
      const value = compileExpression(statement.value, inputs);
      if (statement.isReturn) return value;
      if (statement.isVariableDeclaration) inputs[statement.name] = value.toVar(statement.name);
      else inputs[statement.name].assign(value);
    }
  });
  return { effect, uniforms, generated };
}
