// The starter for a pasted Shadertoy effect: mainImage, iResolution, iTime and iChannel0 (what is
// drawn behind the object) all work here. Like the other starter it is a template, not a look.
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec3 behind = texture(iChannel0, uv).rgb;
  fragColor = vec4(behind * 0.9 + 0.1 * vec3(uv.y), 1.0);
}
