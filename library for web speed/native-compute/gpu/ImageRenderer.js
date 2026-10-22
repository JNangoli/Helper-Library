// GPU image pipeline: adjust -> separable gaussian blur -> present (with vignette).
// Native-feel tricks:
//  * Renders only when something changed (no idle loop: saves battery).
//  * GPU backpressure via fence sync: if the GPU hasn't finished the last frame, skip this
//    one instead of queueing, so input latency never builds up.
//  * Dynamic resolution while interacting: preview scale adapts to how the GPU keeps up,
//    then one full-quality frame when the interaction settles.
//  * Render targets are allocated once per size; previews use a sub-rectangle.
//  * Mipmapped source texture, so downscaled previews stay crisp instead of aliasing.
//  * Survives WebGL context loss (re-uploads the image on restore).
import { DEFAULT_IMAGE_PARAMS } from './params';
import { createSettle } from '../core/util';
import { GpuUnavailableError, Program, createTarget, deleteTarget, drawFullscreen, getWebGL2, onCanvas } from './gl';
const INITIAL_SCALE = { low: 0.5, mid: 0.75, high: 1 };
const MIN_SCALE = 0.25;

const ADJUST_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform float u_exposure;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_temperature;
out vec4 o;
void main() {
  vec4 c = texture(u_src, v_uv);
  vec3 rgb = c.rgb * exp2(u_exposure);
  rgb += vec3(0.08, 0.0, -0.08) * u_temperature;
  rgb = (rgb - 0.5) * (1.0 + u_contrast) + 0.5;
  float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3(l), rgb, 1.0 + u_saturation);
  o = vec4(clamp(rgb, 0.0, 1.0), c.a);
}`;

const BLUR_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_uvScale;
uniform vec2 u_texel;
uniform vec2 u_dir;
uniform float u_radius;
out vec4 o;
vec4 tap(vec2 uv) {
  return texture(u_src, clamp(uv, u_texel * 0.5, u_uvScale - u_texel * 0.5));
}
void main() {
  vec2 uv = v_uv * u_uvScale;
  float sigma = max(u_radius * 0.5, 0.5);
  float stepSize = max(1.0, u_radius / 16.0);
  vec4 sum = vec4(0.0);
  float total = 0.0;
  for (int i = -16; i <= 16; i++) {
    float x = float(i) * stepSize;
    if (abs(x) > u_radius) continue;
    float w = exp(-0.5 * x * x / (sigma * sigma));
    sum += tap(uv + u_dir * u_texel * x) * w;
    total += w;
  }
  o = sum / total;
}`;

const PRESENT_FS = `#version 300 es
precision highp float;
uniform sampler2D u_img;
uniform vec4 u_rect;
uniform vec2 u_uvScale;
uniform vec2 u_texel;
uniform float u_flipY;
uniform float u_premultiply;
uniform float u_vignette;
out vec4 o;
void main() {
  vec2 uv = (gl_FragCoord.xy - u_rect.xy) / u_rect.zw;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) { o = vec4(0.0); return; }
  if (u_flipY > 0.5) uv.y = 1.0 - uv.y;
  vec4 c = texture(u_img, clamp(uv * u_uvScale, u_texel * 0.5, u_uvScale - u_texel * 0.5));
  float v = 1.0 - u_vignette * smoothstep(0.3, 0.85, length(uv - 0.5) * 1.3);
  vec3 rgb = c.rgb * v;
  o = u_premultiply > 0.5 ? vec4(rgb * c.a, c.a) : vec4(rgb, c.a);
}`;

export class ImageRenderer {
  gl;
  adjust;
  blur;
  present;
  source = null;
  bitmap = null;
  chain = null;
  params = { ...DEFAULT_IMAGE_PARAMS };
  interactive = false;
  visible = true;
  dirty = false;
  frameScheduled = false;
  fence = null;
  previewScale;
  lastScale = 1;
  lastWork = [0, 0];
  lost = false;
  disposed = false;
  frames = 0;
  skipped = 0;
  maxTextureSize;

  canvas;
  options;

  constructor(canvas, options) {
    this.canvas = canvas;
    this.options = options;
    const gl = getWebGL2(canvas, {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      desynchronized: true, // low-latency hint where supported
    });
    if (!gl) throw new GpuUnavailableError('WebGL2 is not available');
    this.gl = gl;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.previewScale = INITIAL_SCALE[options.tier ?? 'mid'];
    // One full-quality frame 140 ms after the last change (the user let go).
    this.settle = createSettle(140, () => {
      this.interactive = false;
      this.markDirty();
    });
    this.init();

    onCanvas(canvas, 'webglcontextlost', (e) => {
      e.preventDefault(); // tells the browser we want the context back
      this.lost = true;
      this.chain = null;
      this.source = null;
      this.fence = null;
    });
    onCanvas(canvas, 'webglcontextrestored', () => {
      this.lost = false;
      this.init();
      if (this.bitmap) this.upload(this.bitmap);
      this.markDirty();
    });
  }

  init() {
    const gl = this.gl;
    this.adjust = new Program(gl, ADJUST_FS);
    this.blur = new Program(gl, BLUR_FS);
    this.present = new Program(gl, PRESENT_FS);
    gl.bindVertexArray(gl.createVertexArray());
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
  }

  upload(bitmap) {
    const gl = this.gl;
    if (this.source) gl.deleteTexture(this.source);
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.source = texture;
  }

  // ---- public API ------------------------------------------------------------

  setImage(bitmap) {
    if (this.bitmap && this.bitmap !== bitmap) this.bitmap.close();
    this.bitmap = bitmap;
    if (!this.lost) this.upload(bitmap);
    this.markDirty();
  }

  setParams(patch, interactive) {
    Object.assign(this.params, patch);
    if (interactive) {
      this.interactive = true;
      this.settle.poke();
    }
    this.markDirty();
  }

  resize(width, height) {
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.markDirty();
  }

  setVisible(visible) {
    this.visible = visible;
    if (visible) this.markDirty();
  }

  get stats() {
    return {
      scale: this.lastScale,
      interactive: this.interactive,
      frames: this.frames,
      skipped: this.skipped,
      work: this.lastWork,
      image: this.bitmap ? [this.bitmap.width, this.bitmap.height] : null,
      canvas: [this.canvas.width, this.canvas.height],
    };
  }

  /** Full-resolution render read back to the CPU (straight alpha, top row first). */
  exportPixels(maxSide = Infinity) {
    if (!this.bitmap || !this.source || this.lost) throw new Error('No image loaded');
    const gl = this.gl;
    const iw = this.bitmap.width;
    const ih = this.bitmap.height;
    const s = Math.min(1, maxSide / Math.max(iw, ih), this.maxTextureSize / Math.max(iw, ih));
    const w = Math.max(1, Math.round(iw * s));
    const h = Math.max(1, Math.round(ih * s));
    const chain = this.makeChain(w, h);
    const target = createTarget(gl, w, h);
    try {
      const out = this.process(chain, w, h);
      this.draw(out, target.framebuffer, w, h, [0, 0, w, h], [1, 1], false, false);
      const pixels = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return { pixels: new Uint8ClampedArray(pixels.buffer), width: w, height: h };
    } finally {
      this.deleteChain(chain);
      deleteTarget(gl, target);
      this.markDirty();
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.settle.cancel();
    const gl = this.gl;
    if (this.chain) this.deleteChain(this.chain);
    if (this.source) gl.deleteTexture(this.source);
    [this.adjust, this.blur, this.present].forEach((p) => p?.dispose());
    this.bitmap?.close();
    this.bitmap = null;
    gl.getExtension('WEBGL_lose_context')?.loseContext(); // release GPU memory now
  }

  // ---- frame loop ------------------------------------------------------------

  markDirty() {
    this.dirty = true;
    this.requestFrame();
  }

  requestFrame() {
    if (this.frameScheduled || !this.visible || this.lost || this.disposed) return;
    this.frameScheduled = true;
    this.options.schedule(() => this.frame());
  }

  frame() {
    this.frameScheduled = false;
    if (this.lost || this.disposed || !this.visible) return;
    const gl = this.gl;

    if (this.fence) {
      const done = gl.getSyncParameter(this.fence, gl.SYNC_STATUS) === gl.SIGNALED;
      if (!done) {
        // GPU is behind: drop this frame rather than queue it, and lower preview quality.
        this.skipped++;
        if (this.interactive) this.previewScale = Math.max(MIN_SCALE, this.previewScale * 0.85);
        this.requestFrame();
        return;
      }
      gl.deleteSync(this.fence);
      this.fence = null;
      if (this.interactive) this.previewScale = Math.min(1, this.previewScale * 1.04);
    }

    if (!this.dirty) return;
    this.dirty = false;
    this.render();
    this.frames++;
    this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
  }

  render() {
    const gl = this.gl;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.bitmap || !this.source || !cw || !ch) return;

    const iw = this.bitmap.width;
    const ih = this.bitmap.height;
    const fit = Math.min(cw / iw, ch / ih);
    const dw = iw * fit;
    const dh = ih * fit;

    // Full-quality working size (never larger than the source), then the preview sub-rect.
    const limit = this.maxTextureSize;
    const fullW = Math.max(1, Math.min(limit, Math.round(Math.min(iw, dw))));
    const fullH = Math.max(1, Math.min(limit, Math.round(Math.min(ih, dh))));
    const scale = this.interactive ? Math.round(this.previewScale * 20) / 20 : 1;
    const ww = Math.max(1, Math.round(fullW * scale));
    const wh = Math.max(1, Math.round(fullH * scale));

    const chain = this.ensureChain(fullW, fullH);
    const out = this.process(chain, ww, wh);
    this.draw(out, null, cw, ch, [(cw - dw) / 2, (ch - dh) / 2, dw, dh], [ww / fullW, wh / fullH], true, true);
    this.lastScale = scale;
    this.lastWork = [ww, wh];
  }

  /** Runs adjust (+ blur) into the chain, using a ww x wh sub-rectangle of its targets. */
  process(chain, ww, wh) {
    const gl = this.gl;
    const p = this.params;
    const full = chain.a;
    const uvScale = [ww / full.width, wh / full.height];
    const texel = [1 / full.width, 1 / full.height];

    gl.viewport(0, 0, ww, wh);
    gl.bindFramebuffer(gl.FRAMEBUFFER, chain.a.framebuffer);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.source);
    this.adjust
      .use()
      .setInt('u_src', 0)
      .set('u_exposure', p.exposure)
      .set('u_contrast', p.contrast)
      .set('u_saturation', p.saturation)
      .set('u_temperature', p.temperature);
    drawFullscreen(gl);

    const radius = this.bitmap ? p.blur * (ww / this.bitmap.width) : 0;
    if (radius < 0.5) return chain.a;

    this.blur.use().setInt('u_src', 0).set('u_radius', radius).set('u_uvScale', uvScale).set('u_texel', texel);
    gl.bindFramebuffer(gl.FRAMEBUFFER, chain.b.framebuffer);
    gl.bindTexture(gl.TEXTURE_2D, chain.a.texture);
    this.blur.set('u_dir', [1, 0]);
    drawFullscreen(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, chain.c.framebuffer);
    gl.bindTexture(gl.TEXTURE_2D, chain.b.texture);
    this.blur.set('u_dir', [0, 1]);
    drawFullscreen(gl);
    return chain.c;
  }

  draw(source, framebuffer, vw, vh, rect, uvScale, flipY, premultiply) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(0, 0, vw, vh);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source.texture);
    this.present
      .use()
      .setInt('u_img', 0)
      .set('u_rect', rect)
      .set('u_uvScale', uvScale)
      .set('u_texel', [1 / source.width, 1 / source.height])
      .set('u_flipY', flipY ? 1 : 0)
      .set('u_premultiply', premultiply ? 1 : 0)
      .set('u_vignette', this.params.vignette);
    drawFullscreen(gl);
  }

  ensureChain(width, height) {
    if (this.chain && this.chain.a.width === width && this.chain.a.height === height) return this.chain;
    if (this.chain) this.deleteChain(this.chain);
    this.chain = this.makeChain(width, height);
    return this.chain;
  }

  makeChain(width, height) {
    const t = () => createTarget(this.gl, width, height);
    return { a: t(), b: t(), c: t() };
  }

  deleteChain(chain) {
    deleteTarget(this.gl, chain.a);
    deleteTarget(this.gl, chain.b);
    deleteTarget(this.gl, chain.c);
    if (chain === this.chain) this.chain = null;
  }
}
