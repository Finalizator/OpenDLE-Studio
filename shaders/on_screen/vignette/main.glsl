// A full-screen pass: it is drawn over the finished frame, so it gets the screen as iChannel0 and
// may read it anywhere. A surface shader never does this — a surface only ever shades itself.
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec3 behind = texture(iChannel0, uv).rgb;

  // A soft oval falloff from the centre, and a touch of warmth at the edges.
  vec2 offset = (uv - 0.5) * vec2(1.0, 0.8) * 2.0;
  float vignette = 1.0 - clamp(dot(offset, offset) * 0.32 * strength, 0.0, 0.85);

  fragColor = vec4(behind * vignette, 1.0);
}
