// Water, following the Godot ocean shader in Ancestors/GodotWater (TSS ENTERTAIN, who publishes
// it for any use provided the author is not written out of it). What carried over is the *model*:
// scrolling ripple layers blended at falling weights, choppiness scaling their tilt, exponential
// absorption of the water column, a power-curve fresnel, and foam on the crests.
//
// What could not carry over is Godot's depth texture — a surface effect here is handed no depth
// buffer — so the column of water a pixel looks through is the geometric one instead: the water's
// depth divided by how steeply the view crosses it. Same quantity, derived rather than sampled.
//
// Everything else is drawn from three things a Shadertoy shader could never know: where this pixel
// is, which way the surface faces, and where the camera stands. Guessing the view from the screen
// position is what the first version did, and it turned every highlight into a stripe lying across
// the water — the highlight followed the screen, not the wave.

vec2 rippleLayer(vec2 p, float scale, vec2 drift, float rate) {
  // Three wave trains at spread angles, returned as the *gradient* of their sum rather than as the
  // sines themselves. One train gives parallel bands and two give a woven grid; three at uneven
  // angles interfere into blobs and short crests, which is what a chop looks like. Returns how much
  // this layer tilts the surface in x and z.
  vec2 q = (p + drift * (iTime * rate)) * scale;
  vec2 tilt = vec2(0.0);
  tilt += vec2(0.91, 0.41) * cos(dot(q, vec2(0.91, 0.41)) + 1.7);
  tilt += vec2(-0.54, 0.84) * cos(dot(q, vec2(-0.54, 0.84)) * 1.31 - 0.6);
  tilt += vec2(0.28, -0.96) * cos(dot(q, vec2(0.28, -0.96)) * 0.79 + 2.4);
  return tilt;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec3 wave = normalize(surfaceNormal);
  vec3 eye = normalize(eyePosition - worldPosition);
  float facing = clamp(dot(wave, eye), 0.0, 1.0);

  // Three ripple layers at scales the mesh is too coarse to draw: one broad, one turned across it,
  // one fine. Blended 1 / 0.5 / 0.25 — the weights of a triple-scrolled normal map — the pattern
  // never repeats at a scale the eye can find, which a single layer of sines always does.
  vec2 detail =
      rippleLayer(worldPosition.xz, 0.55, vec2(0.8, 0.45), 1.6)
    + rippleLayer(worldPosition.xz, 0.95, vec2(-0.6, 0.9), 2.3) * 0.5
    + rippleLayer(worldPosition.xz, 1.70, vec2(0.35, -0.8), 3.1) * 0.25;
  // Choppiness: the same ripple tilting the surface harder, which is what makes a sea read as
  // sharp-crested rather than as a rubber sheet.
  detail *= chop;
  // Ripples finer than a pixel are not detail, they are noise — and a sine sampled below its period
  // is the worst of it, a crawling checkerboard. A normal map would fade into its mip chain at
  // distance; a procedural field has to be faded by hand, so the detail thins out with range the way
  // the eye does.
  float range = length(eyePosition - worldPosition);
  detail *= clamp(1.0 - (range - 48.0) / 320.0, 0.12, 1.0);
  vec3 normal = normalize(wave + vec3(detail.x, 0.0, detail.y) * 0.08 * ripple);

  // What is behind the water, bent by the surface's own tilt: the whole difference between water
  // and a blue picture of water.
  vec2 bend = clamp(normal.xz * 2.2, vec2(-0.06), vec2(0.06)) * refraction;
  vec3 behind = texture(iChannel0, clamp(screenUv + bend, vec2(0.001), vec2(0.999))).rgb;

  // How much water this pixel is looking through. Water seen at an angle holds 1/cos of the column
  // underfoot, so the same pool is clear when you look straight down and is its own colour at a
  // grazing angle — exponential absorption, in the shape of the reference's depth term.
  float column = 1.0 / max(facing, 0.14);
  float absorbed = 1.0 - exp(-1.4 * column);

  // The water's own colour, shallow to deep. The brush's colour arrives in linear space, so it is
  // used as it is: scaling it here would be a gamma correction done twice.
  vec3 body = mix(color.rgb * 1.5 + 0.02, color.rgb * 0.55, absorbed);

  // Fresnel: water reflects almost nothing looking straight down and almost everything edge-on.
  float reflectivity = clamp(0.02 + 0.98 * pow(1.0 - facing, fresnel), 0.0, 1.0);

  // The sky it reflects: the bright horizon when the surface is seen edge-on, the deep zenith when it
  // is seen from above. Kept in the renderer's own space, so these read as the blue they look like
  // after the frame is encoded rather than before it.
  vec3 reflected = reflect(-eye, normal);
  float up = clamp(reflected.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 sky = mix(vec3(0.09, 0.17, 0.34), vec3(0.008, 0.03, 0.15), up * up) * sun;

  // The sun. A real eye and a real normal make this a glitter path that follows the waves from
  // wherever the camera stands, which is the one thing that reads as water at a distance.
  vec3 light = normalize(vec3(-0.42, 0.58, 0.70));
  vec3 halfway = normalize(light + eye);
  float glint = pow(clamp(dot(normal, halfway), 0.0, 1.0), 160.0) * sun;
  // The sun itself in the reflection, found by the wave that happens to point at it: this is what a
  // glittering sea is, one narrow bright thing broken into pieces by the surface.
  float disc = pow(clamp(dot(reflected, light), 0.0, 1.0), 900.0) * sun;

  // How much of the body's own colour sits over what is behind it: the pool's density, deepening
  // with the column of water, and the brush's own opacity thinning it out.
  float surface = clamp(density * absorbed * (0.55 + 0.45 * color.a) + reflectivity * 0.5, 0.0, 1.0);
  // The reflection is most of what water *looks* like, and the body colour is what makes it water.
  // A flat mix of the two is a painted sheet; letting the ripples move the reflection is the whole
  // trick, because the sky above is a gradient and every wave then picks a different part of it.
  vec3 shaded = mix(mix(behind, body, surface), sky, clamp(reflectivity * 1.3 + 0.22, 0.0, 1.0));
  shaded += glint * 1.8 + disc * 1.0;

  // Foam on the crests, where the *swell* is steepest: a measurement of the wave, not a texture
  // painted on. Two slow sines stand in for the foam map the reference samples, so the white
  // breaks up as it drifts instead of sitting in one clean band.
  float foamNoise = 0.55 + 0.3 * sin(worldPosition.x * 0.31 + iTime * 0.7) * sin(worldPosition.z * 0.27 - iTime * 0.9);
  float crest = clamp(smoothstep(0.10, 0.26, length(wave.xz)) * foam * foamNoise, 0.0, 1.0);
  shaded = mix(shaded, vec3(0.92, 0.97, 1.0), crest * 0.75);

  // The level behind the surface was already blended in above, so the surface is drawn opaque: a
  // second, half-transparent pass over the same background would mix the level in twice and wash
  // the water out to the colour of whatever is under it.
  fragColor = vec4(shaded, 1.0);
}
