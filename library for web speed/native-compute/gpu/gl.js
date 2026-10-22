// Small WebGL2 toolkit shared by GPU compute and the image renderer.

export class GpuUnavailableError extends Error {
  name = 'GpuUnavailableError';
}

export const isGpuUnavailable = (err) => err instanceof Error && err.name === 'GpuUnavailableError';

export function getWebGL2(canvas, attributes) {
  return canvas.getContext('webgl2', attributes);
}

export function onCanvas(canvas, type, listener) {
  canvas.addEventListener(type, listener);
}

/** Full-screen triangle generated from gl_VertexID: no vertex buffers at all. */
export const FULLSCREEN_VS = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed: ${log}`);
  }
  return shader;
}

export class Program {
  program;
  locations = new Map();

  gl;

  constructor(gl, fragment, vertex = FULLSCREEN_VS) {
    this.gl = gl;
    const vs = compile(gl, gl.VERTEX_SHADER, vertex);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`);
    }
    this.program = program;
  }

  use() {
    this.gl.useProgram(this.program);
    return this;
  }

  loc(name) {
    if (!this.locations.has(name)) this.locations.set(name, this.gl.getUniformLocation(this.program, name));
    return this.locations.get(name);
  }

  set(name, value) {
    const gl = this.gl;
    const loc = this.loc(name);
    if (loc === null) return this;
    if (typeof value === 'number') gl.uniform1f(loc, value);
    else if (value.length === 2) gl.uniform2f(loc, value[0], value[1]);
    else if (value.length === 3) gl.uniform3f(loc, value[0], value[1], value[2]);
    else if (value.length === 4) gl.uniform4f(loc, value[0], value[1], value[2], value[3]);
    else gl.uniform1fv(loc, Array.from(value));
    return this;
  }

  setInt(name, value) {
    const loc = this.loc(name);
    if (loc !== null) this.gl.uniform1i(loc, value);
    return this;
  }

  dispose() {
    this.gl.deleteProgram(this.program);
  }
}

export function createTexture(gl, width, height, internalFormat, format, type, filter, data = null) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

export function createTarget(
  gl,
  width,
  height,
  internalFormat = gl.RGBA8,
  format = gl.RGBA,
  type = gl.UNSIGNED_BYTE,
  filter = gl.LINEAR,
) {
  const texture = createTexture(gl, width, height, internalFormat, format, type, filter);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE && !gl.isContextLost()) {
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    throw new GpuUnavailableError(`Render target not supported (status 0x${status.toString(16)})`);
  }
  return { texture, framebuffer, width, height };
}

export function deleteTarget(gl, target) {
  if (!target) return;
  gl.deleteFramebuffer(target.framebuffer);
  gl.deleteTexture(target.texture);
}

export function drawFullscreen(gl) {
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
