// General-purpose GPU math on Float32Arrays via WebGL2 fragment shaders.
// Each output element is computed by a small GLSL expression over the inputs.
import {
  GpuUnavailableError,
  Program,
  createTarget,
  createTexture,
  deleteTarget,
  drawFullscreen,
  getWebGL2,
  onCanvas,
} from './gl';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(['idx', 'p', 'base', 'kernel', 'main', 'fragColor', 'u_width']);

function uniformDecl(name, value) {
  if (typeof value === 'number') return `uniform float ${name};`;
  if (value.length >= 2 && value.length <= 4) return `uniform vec${value.length} ${name};`;
  return `uniform float ${name}[${value.length}];`;
}

/**
 * map({ inputs, length, glsl, uniforms }) -> Float32Array
 *   inputs    { name: Float32Array } all the same length; in GLSL each is a vec4 of 4 consecutive elements
 *   length    output length (defaults to the inputs' length)
 *   glsl      an expression like "a * b + 1.0", or a body with `return vec4(...)`; `idx` holds the element indices
 *   uniforms  numbers become float uniforms; arrays of 2-4 become vec2-vec4; longer arrays become float[]
 */
export class GpuCompute {
  gl;
  floatTargets = false;
  programs = new Map();
  maxTextureSize;

  constructor(canvas) {
    this.gl = getWebGL2(canvas, {
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    this.maxTextureSize = this.gl ? this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) : 0;
    this.init();
    onCanvas(canvas, 'webglcontextlost', (e) => {
      e.preventDefault();
      this.programs.clear();
    });
    onCanvas(canvas, 'webglcontextrestored', () => this.init());
  }

  init() {
    const gl = this.gl;
    if (!gl) return;
    this.floatTargets = !!gl.getExtension('EXT_color_buffer_float');
    gl.bindVertexArray(gl.createVertexArray());
  }

  get hasWebGL2() {
    return !!this.gl;
  }

  get available() {
    return !!this.gl && this.floatTargets && !this.gl.isContextLost();
  }

  map(request) {
    if (!this.available) throw new GpuUnavailableError('GPU float compute is not available on this device');
    const gl = this.gl;
    const inputs = request.inputs ?? {};
    const names = Object.keys(inputs);
    const uniforms = request.uniforms ?? {};
    for (const n of [...names, ...Object.keys(uniforms)]) {
      if (!NAME.test(n) || RESERVED.has(n)) throw new Error(`Invalid or reserved GLSL name "${n}"`);
    }
    const length = request.length ?? (names.length ? inputs[names[0]].length : 0);
    for (const n of names) {
      if (inputs[n].length !== length)
        throw new Error(`Input "${n}" has length ${inputs[n].length}, expected ${length}`);
    }
    if (!length) return new Float32Array(0);

    const texels = Math.ceil(length / 4);
    const width = Math.min(texels, this.maxTextureSize);
    const height = Math.ceil(texels / width);
    if (height > this.maxTextureSize) {
      throw new RangeError(`Too many elements for one pass (max ${this.maxTextureSize ** 2 * 4}); split the data`);
    }
    const size = width * height * 4;
    const program = this.program(names, request.glsl, uniforms);

    const textures = names.map((name, unit) => {
      let data = inputs[name];
      if (data.length !== size) {
        const padded = new Float32Array(size);
        padded.set(data);
        data = padded;
      }
      gl.activeTexture(gl.TEXTURE0 + unit);
      const texture = createTexture(gl, width, height, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST, data);
      return texture;
    });
    const target = createTarget(gl, width, height, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST);

    try {
      program.use();
      names.forEach((name, unit) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, textures[unit]);
        program.setInt(`u_in_${name}`, unit);
      });
      program.setInt('u_width', width);
      for (const [name, value] of Object.entries(uniforms)) program.set(name, value);

      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, width, height);
      drawFullscreen(gl);
      const out = new Float32Array(size);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, out);
      if (gl.isContextLost()) throw new GpuUnavailableError('GPU context lost during compute');
      return out.length === length ? out : out.slice(0, length);
    } finally {
      textures.forEach((t) => gl.deleteTexture(t));
      deleteTarget(gl, target);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  }

  program(names, glsl, uniforms) {
    const decls = Object.entries(uniforms).map(([n, v]) => uniformDecl(n, v));
    const key = `${names.join(',')}|${decls.join('')}|${glsl}`;
    const cached = this.programs.get(key);
    if (cached) return cached;

    const params = [...names.map((n) => `vec4 ${n}`), 'vec4 idx'].join(', ');
    const args = [...names.map((n) => `texelFetch(u_in_${n}, p, 0)`), 'idx'].join(', ');
    const body = /\breturn\b/.test(glsl) ? glsl : `return vec4(${glsl});`;
    const source = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
${names.map((n) => `uniform sampler2D u_in_${n};`).join('\n')}
uniform int u_width;
${decls.join('\n')}
out vec4 fragColor;
vec4 kernel(${params}) {
${body}
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float base = float((p.y * u_width + p.x) * 4);
  vec4 idx = base + vec4(0.0, 1.0, 2.0, 3.0);
  fragColor = kernel(${args});
}`;
    const program = new Program(this.gl, source);
    if (this.programs.size >= 32) {
      const [oldestKey, oldest] = this.programs.entries().next().value;
      oldest.dispose();
      this.programs.delete(oldestKey);
    }
    this.programs.set(key, program);
    return program;
  }
}
