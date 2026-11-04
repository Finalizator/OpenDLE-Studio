/**
 * Builds the Shader Engine's full-screen pass chain as a Three TSL node graph.
 *
 * Every technique in `shared/post-fx.js` becomes one function here; the stack runs them in
 * the project's order over the frame the renderer has already drawn. Depth comes from the
 * render target's depth texture, which is turned back into view-space positions and normals
 * the same way the book's position/normal G-buffer is: the book renders a position texture,
 * a forward renderer can reconstruct it, and everything after that is the book's math.
 *
 * The uniforms are created here and written by the renderer every frame, so an event can
 * change a parameter without rebuilding a shader.
 */
import {
  Fn, If, Loop, abs, clamp, cos, cross, dot, float, floor, fract, length, max, min, mix, mod,
  normalize, pow, select, sin, smoothstep, sqrt, texture, uniform, vec2, vec3, vec4, screenUV,
  perspectiveDepthToViewZ,
} from 'three/tsl';
import { POST_FX_BY_KIND, activePostFxPasses, postFxParamDefault } from '../shared/post-fx.js';

const GOLDEN_ANGLE = 2.39996323;
const PI_OVER_4 = Math.PI / 4;
const LUMA = vec3(0.21, 0.72, 0.07);

/** A cheap, stable hash, the noise source every pass here shares. */
const hash = Fn(([seed]) => fract(sin(dot(seed, vec2(127.1, 311.7))).mul(43758.5453)));

/** Bilinear value noise: the book's flow maps, foam breakup and film grain all need one. */
const valueNoise = Fn(([point]) => {
  const cell = floor(point), local = fract(point);
  const fade = local.mul(local).mul(vec2(3).sub(local.mul(2)));
  const a = hash(cell);
  const b = hash(cell.add(vec2(1, 0)));
  const c = hash(cell.add(vec2(0, 1)));
  const d = hash(cell.add(vec2(1, 1)));
  return mix(mix(a, b, fade.x), mix(c, d, fade.x), fade.y);
});

/** The lookup-table grade: a 16×16×16 table laid out as a 256×16 strip, sampled per channel. */
const LUT_SIZE = 16;

/**
 * @param {object} options
 * @param {object} options.colorTexture the rendered frame
 * @param {object} [options.depthTexture] its depth attachment, for the screen-space passes
 * @param {object} [options.historyTexture] the previous frame, for motion blur
 * @param {object} [options.lutTexture] the grade table, for the lookup-table pass
 * @param {Array} options.passes enabled passes from `activePostFxPasses`
 * @param {object} options.near camera near plane uniform
 * @param {object} options.far camera far plane uniform
 * @param {object} options.projection vec2 of tan(fov/2)·aspect and tan(fov/2)
 * @param {object} options.resolution vec2 viewport size in pixels
 * @param {object} options.time seconds since the level started
 */
export function createPostFxStack({ colorTexture, depthTexture = null, historyTexture = null, lutTexture = null,
  passes = [], near, far, projection, resolution, time }) {
  const uniforms = {};
  const params = new Map(passes.map(pass => [pass.kind, pass.params || {}]));
  const enabled = new Set(passes.map(pass => pass.kind));
  const param = (kind, name) => {
    const key = `${kind}.${name}`;
    if (!uniforms[key]) uniforms[key] = uniform(postFxParamDefault(kind, name));
    return uniforms[key];
  };
  const value = (kind, name) => {
    const stored = params.get(kind)?.[name];
    return Number.isFinite(stored) ? stored : postFxParamDefault(kind, name);
  };

  const texel = resolution.reciprocal();
  const has = kind => enabled.has(kind);
  const st = screenUV;

  /**
   * A render target holds linear light, but every technique in the book works on the
   * picture as it is seen — posterisation bands in display space, gamma is display gamma.
   * The chain therefore runs in display space and converts back at the end, where the
   * renderer applies its own output transform on the way to the canvas.
   */
  const toDisplay = color => pow(max(color, vec3(0)), vec3(1 / 2.2));
  const toLinear = color => pow(max(color, vec3(0)), vec3(2.2));
  const readColor = at => toDisplay(texture(colorTexture, at).rgb);
  const rawDepth = at => (depthTexture ? texture(depthTexture, at).x : float(1));
  /** Distance from the camera to the surface at a screen position, in world units. */
  const distanceAt = at => perspectiveDepthToViewZ(rawDepth(at), near, far).mul(-1);
  /** Screen position to view-space position: the book's position buffer, reconstructed. */
  const viewPosition = at => {
    const distance = distanceAt(at);
    const ndc = at.mul(2).sub(1);
    return vec3(ndc.x.mul(projection.x).mul(distance), ndc.y.mul(projection.y).mul(distance), distance.negate());
  };
  /** View-space position back to a screen position, so a sample can look itself up. */
  const toScreen = point => {
    const depth = point.z.negate().max(0.001);
    return vec2(point.x.div(projection.x.mul(depth)), point.y.div(projection.y.mul(depth))).mul(0.5).add(0.5);
  };

  // Detail normals from the normal-mapping pass, applied wherever a normal is used, so the
  // stack order does not change what the surface looks like.
  const detailStrength = has('normalMapping') ? param('normalMapping', 'strength') : float(0);
  const detailScale = has('normalMapping') ? param('normalMapping', 'scale') : float(1);
  const normalAt = at => {
    const left = viewPosition(at.sub(vec2(texel.x, 0)));
    const right = viewPosition(at.add(vec2(texel.x, 0)));
    const down = viewPosition(at.sub(vec2(0, texel.y)));
    const up = viewPosition(at.add(vec2(0, texel.y)));
    let normal = normalize(cross(right.sub(left), up.sub(down)));
    if (has('normalMapping')) {
      const bumpAt = point => valueNoise(point.mul(detailScale));
      const height = bumpAt(at);
      const bump = vec3(bumpAt(at.add(vec2(texel.x.mul(4), 0))).sub(height),
        bumpAt(at.add(vec2(0, texel.y.mul(4)))).sub(height), 0).mul(detailStrength.mul(60));
      normal = normalize(normal.add(bump));
    }
    return normal;
  };

  /** The 3×3 maximum depth jump around a fragment: the edge signal outlining, cel and rim share. */
  const depthJump = (at, radius) => {
    const centre = distanceAt(at), jump = float(0).toVar();
    Loop(9, ({ i }) => {
      const offset = vec2(float(i).mod(3).sub(1), float(i).div(3).floor().sub(1)).mul(radius).mul(texel);
      jump.assign(max(jump, abs(centre.sub(distanceAt(at.add(offset))))));
    });
    return jump;
  };

  /**
   * How much the depth jumps *relative to its own distance*. An absolute jump in world
   * units fires on every grazing floor — a corridor floor's depth changes by metres between
   * neighbouring pixels — which inks the whole frame; a silhouette changes by a large
   * fraction of its distance and nothing else does. Cel ink, rim light and foam measure
   * this instead, so their thresholds mean the same thing at any distance.
   */
  const relativeDepthJump = (at, radius) => {
    const centre = distanceAt(at), relative = float(0).toVar();
    Loop(8, ({ i }) => {
      const angle = float(i).mul(PI_OVER_4);
      const offset = vec2(cos(angle), sin(angle)).mul(radius).mul(texel);
      const neighbour = distanceAt(at.add(offset));
      relative.assign(max(relative, abs(centre.sub(neighbour)).div(max(centre, float(0.001)))));
    });
    return relative;
  };

  /** A five-by-five box of samples at `radius` pixels, the window the book's blur uses. */
  const boxSample = (at, radius, read = readColor) => {
    const total = vec3(0).toVar(), taps = float(0).toVar();
    Loop(25, ({ i }) => {
      const offset = vec2(float(i).mod(5).sub(2), float(i).div(5).floor().sub(2)).mul(0.5).mul(radius).mul(texel);
      total.addAssign(read(at.add(offset)));
      taps.addAssign(1);
    });
    return total.div(taps);
  };

  /** Points around a circle, so the disc-shaped passes do not sample a square window. */
  const discOffset = index => vec2(cos(index.mul(GOLDEN_ANGLE)), sin(index.mul(GOLDEN_ANGLE)))
    .mul(sqrt(index.add(0.5).div(12)));

  const techniques = {
    // The book's Blinn-Phong: diffuse plus a half-vector highlight, lit from a screen-space sun.
    blinnPhong: () => {
      const angle = param('blinnPhong', 'lightAngle').mul(Math.PI / 180);
      const lightDirection = normalize(vec3(cos(angle).mul(-1), sin(angle).mul(0.8), float(-1)));
      const normal = normalAt(st);
      const viewDirection = normalize(viewPosition(st).negate());
      const diffuse = max(dot(normal, lightDirection), 0).mul(param('blinnPhong', 'diffuse'));
      const half = normalize(lightDirection.add(viewDirection));
      const specular = pow(max(dot(normal, half), 0), param('blinnPhong', 'shininess'))
        .mul(param('blinnPhong', 'specular'));
      return color => color.mul(float(1).add(diffuse)).add(specular.mul(vec3(1)));
    },
    // Detail normals handled by normalAt; the pass itself only has to be present.
    normalMapping: () => color => color,
    gamma: () => {
      const gamma = param('gamma', 'gamma');
      return color => pow(max(color, vec3(0)), vec3(1).div(gamma));
    },
    blur: () => {
      const radius = param('blur', 'size').mul(param('blur', 'separation'));
      return () => boxSample(st, radius);
    },
    bloom: () => {
      const threshold = param('bloom', 'threshold'), intensity = param('bloom', 'intensity');
      const separation = param('bloom', 'separation');
      const brightAt = at => max(readColor(at).sub(threshold), vec3(0));
      const spread = vec3(0).toVar(), weight = float(0).toVar();
      Loop(12, ({ i }) => {
        const offset = vec2(cos(float(i).mul(GOLDEN_ANGLE)), sin(float(i).mul(GOLDEN_ANGLE)))
          .mul(float(i).add(1).div(12)).mul(separation).mul(texel);
        spread.addAssign(brightAt(st.add(offset)));
        weight.addAssign(1);
      });
      spread.addAssign(brightAt(st));
      return color => color.add(spread.div(weight.add(1)).mul(intensity));
    },
    outline: () => {
      const thickness = param('outline', 'thickness');
      const low = param('outline', 'minDistance'), high = param('outline', 'maxDistance');
      const strength = param('outline', 'strength');
      return color => {
        // The book spreads the window further out with distance, so far edges stay visible.
        const separation = thickness.mul(smoothstep(0, 1, clamp(distanceAt(st).div(far), 0, 1)).mul(2).add(1));
        const edge = smoothstep(low, high, depthJump(st, separation)).mul(strength);
        return mix(color, color.mul(vec3(0.324, 0.063, 0.099)), edge);
      };
    },
    dilation: () => {
      const radius = param('dilation', 'size').mul(param('dilation', 'separation'));
      const low = param('dilation', 'threshold'), strength = param('dilation', 'strength');
      const brightest = vec3(0).toVar(), brightestLuma = float(0).toVar();
      Loop(25, ({ i }) => {
        const offset = vec2(float(i).mod(5).sub(2), float(i).div(5).floor().sub(2)).mul(radius).mul(texel);
        const sample = readColor(st.add(offset));
        const luma = dot(sample, LUMA);
        If(luma.greaterThan(brightestLuma), () => { brightest.assign(sample); brightestLuma.assign(luma); });
      });
      return color => mix(color, brightest, smoothstep(low, low.add(0.3), brightestLuma).mul(strength));
    },
    cel: () => {
      const steps = param('cel', 'steps'), ink = param('cel', 'edge');
      const threshold = param('cel', 'edgeThreshold');
      return color => {
        // Quantising the luminance and keeping the hue is the book's gradient map, written
        // as one multiplication instead of a strip texture. The band is taken from a blurred
        // copy of the frame and applied as a gain, so the *shading* goes flat while the
        // artwork inside each band keeps its detail — quantising each pixel instead turned a
        // detailed sky into coloured blobs. The gain is clamped because an unclamped one
        // sends the darkest band to zero, and a dim corridor becomes a black rectangle.
        const softLuma = dot(boxSample(st, float(8)), LUMA);
        const banded = floor(softLuma.mul(steps)).div(steps).add(float(0.5).div(steps));
        const gain = clamp(banded.div(max(softLuma, float(0.02))), float(0.45), float(1.35));
        const bandedColor = color.mul(gain);
        // Ink the outline, never the inside of a surface: a relative jump is what separates
        // the two (see relativeDepthJump).
        const edge = smoothstep(threshold, threshold.mul(2.5), relativeDepthJump(st, float(1.4))).mul(ink);
        return mix(bandedColor, bandedColor.mul(vec3(0.2, 0.18, 0.22)), edge);
      };
    },
    posterize: () => {
      const levels = param('posterize', 'levels');
      return color => floor(color.mul(levels)).div(levels);
    },
    pixelization: () => {
      const block = param('pixelization', 'size');
      const size = block.mul(texel);
      const centre = st.div(size).floor().mul(size).add(size.mul(0.5));
      return () => readColor(centre);
    },
    sharpen: () => {
      const radius = param('sharpen', 'separation'), amount = param('sharpen', 'amount');
      return color => color.add(color.sub(boxSample(st, radius)).mul(amount));
    },
    chromaticAberration: () => {
      const amount = param('chromaticAberration', 'amount'), falloff = param('chromaticAberration', 'falloff');
      const toward = st.sub(0.5);
      const bend = toward.mul(amount).mul(pow(max(length(toward).mul(2), 0), falloff));
      return () => vec3(readColor(st.add(bend)).r, readColor(st).g, readColor(st.sub(bend)).b);
    },
    lut: () => {
      const amount = param('lut', 'amount');
      if (!lutTexture) return color => color;
      return color => {
        // Blue picks the slice of the table, red the column inside it, green the row — the
        // layout the book's lookup table uses, with the table itself built by the renderer.
        const blue = clamp(color.b, 0, 1).mul(LUT_SIZE - 1);
        const across = fract(blue).add(floor(blue).mul(LUT_SIZE)).add(clamp(color.r, 0, 1).mul(LUT_SIZE - 1));
        const row = clamp(color.g, 0, 1);
        const graded = clamp(texture(lutTexture, vec2(across.div(LUT_SIZE * LUT_SIZE), row)).rgb, 0, 1);
        return mix(color, graded, amount);
      };
    },
    fog: () => {
      const start = param('fog', 'near'), end = param('fog', 'far'), density = param('fog', 'density');
      const fogColor = vec3(param('fog', 'red'), param('fog', 'green'), param('fog', 'blue'));
      return color => mix(color, fogColor, smoothstep(start, max(end, start.add(1)), distanceAt(st)).mul(density));
    },
    depthOfField: () => {
      const focus = param('depthOfField', 'focus'), range = param('depthOfField', 'range');
      const blur = param('depthOfField', 'blur');
      return color => {
        const distance = distanceAt(st);
        const coc = clamp(abs(distance.sub(focus)).div(max(range, float(1))), 0, 1);
        const total = vec3(0).toVar(), weight = float(0).toVar();
        Loop(12, ({ i }) => {
          const index = float(i);
          const offset = discOffset(index).mul(blur).mul(coc).mul(texel);
          // A neighbour that is itself in focus should not bleed into a blurred fragment.
          const neighbour = distanceAt(st.add(offset));
          const neighbourCoc = clamp(abs(neighbour.sub(focus)).div(max(range, float(1))), 0, 1);
          total.addAssign(readColor(st.add(offset)).mul(neighbourCoc));
          weight.addAssign(neighbourCoc);
        });
        const blurred = select(weight.greaterThan(0.001), total.div(max(weight, float(0.001))), color);
        return mix(color, blurred, coc);
      };
    },
    motionBlur: () => {
      const amount = param('motionBlur', 'amount');
      if (!historyTexture) return color => color;
      return color => mix(color, texture(historyTexture, st).rgb, amount);
    },
    ssao: () => {
      const radius = param('ssao', 'radius'), intensity = param('ssao', 'intensity'), bias = param('ssao', 'bias');
      return color => {
        const position = viewPosition(st);
        const occlusion = float(0).toVar();
        Loop(12, ({ i }) => {
          const samplePoint = position.add(vec3(discOffset(float(i)).mul(radius), 0));
          const sampled = distanceAt(toScreen(samplePoint));
          // Closer geometry in front of the hemisphere sample occludes the fragment.
          const occluded = select(samplePoint.z.negate().sub(sampled).greaterThan(bias), float(1), float(0));
          occlusion.addAssign(occluded.mul(smoothstep(float(0), float(1), radius.div(max(abs(sampled.sub(position.z.negate())), float(0.001))))));
        });
        const ao = clamp(float(1).sub(occlusion.div(12).mul(intensity)), 0, 1);
        // The sky has no geometry to occlude it; leave it alone.
        return color.mul(mix(ao, float(1), smoothstep(0.999, 1, rawDepth(st))));
      };
    },
    ssr: () => {
      const strength = param('ssr', 'strength'), rayLength = param('ssr', 'rayLength');
      const thickness = param('ssr', 'thickness');
      return color => {
        const position = viewPosition(st);
        const normal = normalAt(st);
        const viewDirection = normalize(position);
        const reflected = viewDirection.sub(normal.mul(dot(viewDirection, normal).mul(2)));
        const stepSize = rayLength.div(16);
        const hit = float(0).toVar(), hitUv = vec2(0).toVar();
        Loop(16, ({ i }) => {
          const march = position.add(reflected.mul(stepSize.mul(float(i).add(1))));
          const screen = toScreen(march);
          const inside = screen.x.greaterThan(0).and(screen.y.greaterThan(0)).and(screen.x.lessThan(1)).and(screen.y.lessThan(1));
          const surface = distanceAt(screen);
          // `.negate()` on the uniform node: a JavaScript minus would turn it into NaN.
          const crossed = march.z.negate().sub(surface).greaterThan(thickness.negate()).and(march.z.negate().lessThan(surface.add(thickness)));
          If(inside.and(crossed), () => { hit.assign(1); hitUv.assign(screen); });
        });
        const fresnel = pow(float(1).sub(clamp(abs(dot(normal, normalize(viewDirection))), 0, 1)), 3);
        return mix(color, readColor(hitUv), clamp(hit.mul(strength).mul(fresnel.add(0.15)), 0, 1));
      };
    },
    ssrRefraction: () => {
      const strength = param('ssrRefraction', 'strength'), dispersion = param('ssrRefraction', 'dispersion');
      const depthScale = param('ssrRefraction', 'depthScale');
      return () => {
        const normal = normalAt(st);
        const bend = normal.xy.mul(strength).mul(depthScale.div(10));
        const spread = bend.mul(dispersion);
        return vec3(readColor(st.add(bend.add(spread))).r, readColor(st.add(bend)).g,
          readColor(st.add(bend.sub(spread))).b);
      };
    },
    fresnel: () => {
      const power = param('fresnel', 'power'), intensity = param('fresnel', 'intensity');
      return color => {
        const normal = normalAt(st);
        const viewDirection = normalize(viewPosition(st).negate());
        const rim = pow(float(1).sub(clamp(abs(dot(normal, viewDirection)), 0, 1)), power).mul(intensity);
        return color.add(rim);
      };
    },
    rim: () => {
      const power = param('rim', 'power'), intensity = param('rim', 'intensity');
      const rimColor = vec3(param('rim', 'red'), param('rim', 'green'), param('rim', 'blue'));
      return color => {
        const edge = smoothstep(0.05, 0.35, relativeDepthJump(st, float(1.5)));
        const normal = normalAt(st);
        const facing = pow(float(1).sub(clamp(abs(normal.z), 0, 1)), power);
        return color.add(rimColor.mul(edge.mul(facing).mul(intensity)));
      };
    },
    flow: () => {
      const strength = param('flow', 'strength'), speed = param('flow', 'speed'), scale = param('flow', 'scale');
      return () => {
        const drift = vec2(time.mul(speed), time.mul(speed).mul(-0.7));
        const first = valueNoise(st.mul(scale).add(drift));
        const second = valueNoise(st.mul(scale.mul(1.7)).sub(drift.mul(1.3)));
        const offset = vec2(first.sub(0.5), second.sub(0.5)).mul(strength.mul(2));
        return readColor(st.add(offset));
      };
    },
    foam: () => {
      const threshold = param('foam', 'threshold'), amount = param('foam', 'amount');
      const scale = param('foam', 'scale');
      return color => {
        const jump = relativeDepthJump(st, float(1.6));
        const foam = smoothstep(threshold.mul(0.5), threshold, jump).mul(amount);
        const breakup = valueNoise(st.mul(scale).add(vec2(time.mul(0.6), 0))).mul(0.6).add(0.4);
        return mix(color, vec3(1), clamp(foam.mul(breakup), 0, 1));
      };
    },
    filmGrain: () => {
      const amount = param('filmGrain', 'amount'), scale = param('filmGrain', 'scale');
      return color => {
        const grain = hash(floor(st.mul(resolution).div(max(scale, float(0.1)))).add(time.mul(60)));
        return color.add(grain.sub(0.5).mul(amount));
      };
    },
  };

  // Every parameter of every enabled pass gets its uniform up front, so the renderer can
  // write values before the graph is first built and keep writing them afterwards.
  for (const pass of passes) if (POST_FX_BY_KIND.has(pass.kind)) for (const name of Object.keys(pass.params || {})) param(pass.kind, name);

  const combined = Fn(() => {
    let color = readColor(st);
    // Building inside the Fn keeps every local variable in the shader's own scope.
    for (const pass of passes) {
      const technique = techniques[pass.kind];
      if (technique) color = technique()(color);
    }
    return vec4(clamp(toLinear(color), vec3(0), vec3(1)), 1);
  });

  return { node: combined(), uniforms };
}

/** The stack the renderer builds when nothing is selected: the frame, untouched. */
export function passthroughPostFxStack({ colorTexture, near, far, projection, resolution, time }) {
  return createPostFxStack({ colorTexture, near, far, projection, resolution, time, passes: [] });
}

export { activePostFxPasses };
