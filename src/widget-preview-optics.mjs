const vertex = 'attribute vec2 position; void main() { gl_Position = vec4(position, 0.0, 1.0); }';

// Same sharp superellipse lens and Snell refraction as native LensPS.
// The only input texture here is the demonstration wallpaper.
const fragment = `
precision highp float;
uniform sampler2D backdrop;
uniform vec2 stageSize, imageSize;
uniform vec4 lens, rows, quotas;
uniform float unit, radius, bezelWidth, distortion, lightMode;

vec3 scene(vec2 p) {
  float cover = max(stageSize.x / imageSize.x, stageSize.y / imageSize.y);
  vec2 uv = (p - stageSize * .5) / (imageSize * cover) + .5;
  return texture2D(backdrop, uv).rgb;
}

float insideShape(vec2 q, vec2 halfSize, float r) {
  vec2 d = abs(q) - (halfSize - r), v = max(d, 0.0);
  if (max(d.x, d.y) <= 0.0) return r - max(d.x, d.y);
  vec2 squared = v * v;
  float n = sqrt(sqrt(dot(squared, squared)));
  return (r - n) / max(length(v * squared) / (n * n * n), .000001);
}

float refractDistance(float depth) {
  float s = clamp(depth / bezelWidth, 0.0, .9999);
  float z = sqrt(1.0 - (1.0 - s) * (1.0 - s));
  float next = sqrt(1.0 - (.9999 - s) * (.9999 - s));
  float slope = (next - z) / .0001, normalLength = sqrt(slope * slope + 1.0);
  float nx = -slope / normalLength, ny = -1.0 / normalLength, eta = 1.0 / 1.5;
  float term = eta * ny + sqrt(1.0 - eta * eta * (1.0 - ny * ny));
  return (-term * nx) * ((z * bezelWidth + 72.0) / (eta - term * ny)) * (127.0 / 255.0) * distortion;
}

float bell(float distance, float center, float width) {
  float t = (distance - center) / width;
  return exp(-t * t);
}

float materialMask(vec4 grid, vec2 p, float height, float bottomInset, float r) {
  float fromBottom = grid.y - p.y;
  float pitch = (height + 4.0) * unit;
  if (fromBottom <= 0.0 || fromBottom >= grid.w * pitch || p.x <= grid.x || p.x >= grid.x + grid.z) return 0.0;
  vec2 halfSize = vec2(grid.z * .5, height * .5 * unit);
  vec2 local = vec2(p.x - grid.x - halfSize.x, mod(fromBottom, pitch) - bottomInset * unit - halfSize.y);
  return clamp(insideShape(local, halfSize, r * unit) + .5, 0.0, 1.0);
}

vec3 frostedScene(vec2 p, float blur) {
  vec3 color = vec3(0.0);
  float near = floor(blur * .13) + .5, far = floor(blur * .60) + .5;
  for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) {
    float ax = abs(float(x)), ay = abs(float(y));
    vec2 tap = sign(vec2(float(x), float(y))) * vec2(ax == 2.0 ? far : near, ay == 2.0 ? far : near);
    float xWeight = ax == 2.0 ? .15 : (ax == 1.0 ? .26 : .18);
    float yWeight = ay == 2.0 ? .15 : (ay == 1.0 ? .26 : .18);
    color += scene(p + tap * unit) * xWeight * yWeight;
  }
  return color;
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, stageSize.y - gl_FragCoord.y);
  vec2 halfSize = lens.zw * .5;
  vec2 q = p - lens.xy - halfSize;
  float r = min(radius * unit, min(halfSize.x, halfSize.y));
  float inside = insideShape(q, halfSize, r);
  if (inside <= -.5) { gl_FragColor = vec4(scene(p), 1.0); return; }

  vec2 d = abs(q) - (halfSize - r), v = max(d, 0.0);
  vec2 cube = v * v * v;
  vec2 normal = length(cube) > .0001 ? normalize(cube) * sign(q)
    : (d.x > d.y ? vec2(sign(q.x), 0.0) : vec2(0.0, sign(q.y)));
  float depth = inside / unit;
  float shift = depth < bezelWidth && distortion > 0.0 ? unit * refractDistance(depth) : 0.0;
  vec3 color = scene(p - shift * normal);

  // Request and quota backing sample the undeformed backdrop independently.
  float requestFrost = materialMask(rows, p, 23.0, 2.0, clamp(radius - 16.0, 0.0, 10.0));
  float quotaFrost = materialMask(quotas, p, 24.0, 0.0, 12.0);
  if (requestFrost > 0.0) color = mix(color, frostedScene(p, 9.0), requestFrost);
  else if (quotaFrost > 0.0) color = mix(color, frostedScene(p, 7.0), quotaFrost);

  vec3 veil = mix(vec3(.014, .017, .020), vec3(.965, .972, .975), lightMode);
  color = mix(color, veil, mix(.025, .76, lightMode));
  float rim = .57 * bell(depth, .55, .88) + .24 * bell(depth, 1.8, 1.35) + .10 * bell(depth, 4.4, 3.4);
  float sky = dot(normal, normalize(vec2(-.65, -.82)));
  float light = .23 + .65 * pow(max(0.0, sky * .55 + .45), 1.55) + .22 * max(0.0, -sky);
  color = mix(color, color * .53, lightMode * .30 * bell(depth, .7, 1.3));
  color += rim * light * mix(vec3(.61, .66, .83), vec3(.99), lightMode);
  gl_FragColor = vec4(mix(scene(p), color, clamp(inside + .5, 0.0, 1.0)), 1.0);
}
`;

export function createWidgetPreviewOptics(canvas, image) {
  const gl = canvas.getContext('webgl', { alpha: false, depth: false, antialias: false, powerPreference: 'low-power' });
  if (!gl) return null;
  const program = gl.createProgram();
  const shaders = [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]].map(([type, source]) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
    return shader;
  });
  gl.linkProgram(program);
  for (const shader of shaders) gl.deleteShader(shader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'position');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  const uniforms = Object.fromEntries(['stageSize', 'imageSize', 'lens', 'rows', 'quotas', 'unit', 'radius', 'bezelWidth', 'distortion', 'lightMode']
    .map(name => [name, gl.getUniformLocation(program, name)]));
  gl.uniform2f(uniforms.imageSize, image.naturalWidth, image.naturalHeight);

  return {
    draw(panel, { radius, bezelWidth, distortion, scale, theme }) {
      const stage = canvas.getBoundingClientRect(), lens = panel.getBoundingClientRect();
      if (!stage.width || !stage.height) return;
      const dpi = devicePixelRatio || 1;
      const width = Math.round(stage.width * dpi), height = Math.round(stage.height * dpi);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const requests = panel.querySelector('.widget-requests');
      const rows = requests.getBoundingClientRect();
      const quotaBars = panel.querySelectorAll('.widget-quota-bar');
      const lastQuota = quotaBars[quotaBars.length - 1]?.getBoundingClientRect();
      gl.viewport(0, 0, width, height);
      gl.uniform2f(uniforms.stageSize, width, height);
      gl.uniform4f(uniforms.lens, (lens.x - stage.x) * dpi, (lens.y - stage.y) * dpi, lens.width * dpi, lens.height * dpi);
      gl.uniform4f(uniforms.rows, (rows.x - stage.x) * dpi, (rows.bottom - stage.y) * dpi, rows.width * dpi, requests.childElementCount);
      if (lastQuota) gl.uniform4f(uniforms.quotas, (lastQuota.x - stage.x) * dpi, (lastQuota.bottom - stage.y) * dpi, lastQuota.width * dpi, quotaBars.length);
      else gl.uniform4f(uniforms.quotas, 0, 0, 0, 0);
      gl.uniform1f(uniforms.unit, scale * dpi);
      gl.uniform1f(uniforms.radius, radius);
      gl.uniform1f(uniforms.bezelWidth, bezelWidth);
      gl.uniform1f(uniforms.distortion, distortion / 100);
      gl.uniform1f(uniforms.lightMode, theme === 'light' ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      canvas.dataset.painted = '';
    },
    dispose() {
      gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    },
  };
}
