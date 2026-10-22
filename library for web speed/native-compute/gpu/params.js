// Plain data shared by the main thread and the GPU worker (no GPU code here).

export const DEFAULT_IMAGE_PARAMS = {
  exposure: 0, // stops of light, -2..2
  contrast: 0, // -1..1
  saturation: 0, // -1..1 (-1 = greyscale)
  temperature: 0, // -1 cool .. 1 warm
  blur: 0, // radius in source-image pixels, 0..100
  vignette: 0, // 0..1
};
