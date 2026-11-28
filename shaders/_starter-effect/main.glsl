// The starter for a new GLSL effect. Pair it with uniforms: { strength: 1 } for a live-editable tint
// gain. A shader marked "starter" is a template, not a look: it is never offered on a brush or over
// the frame, it is what a new effect begins as.
vec4 effect(vec4 color, vec2 uv, float time) {
  float pulse = 0.75 + 0.25 * sin(time + uv.x * 6.2831853);
  vec3 tint = color.rgb * pulse * strength;
  return vec4(tint, color.a);
}
