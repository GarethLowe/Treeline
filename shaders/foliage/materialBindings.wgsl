// Group 2 — the shared material texture arrays from `IMaterialSystem`.
//
// RECONCILED AGAINST WP 1.6, 2026-08-19. This file originally assumed the sampler sat at
// binding 3 — the natural reading of the contract, which exposes `bindGroupLayout` and
// `createBindGroup()` without pinning what is at which index. It guessed wrong, and the
// author correctly predicted both the failure and the fix:
//
//     "If WP 1.6 numbers them differently the fix is this file and nothing else."
//
// It was. The real layout, from `MaterialSystem.bindGroupLayout` in
// `src/render/materials/materialSystem.ts`, is:
//
//     @binding(0) albedoArray      texture_2d_array<f32>   (sRGB-decoded, alpha = coverage)
//     @binding(1) normalArray      texture_2d_array<f32>
//     @binding(2) ormArray         texture_2d_array<f32>   (occlusion / roughness / metallic)
//     @binding(3) crackField       texture_2d<f32>         (burn/char cracking, M4)
//     @binding(4) materialSampler  filtering
//     @binding(5) materialTable    uniform
//
// Until this was corrected, `foliage.treeDraw` and `foliage.grassDraw` both failed pipeline
// creation with "Binding type in the shader (sampler) doesn't match the type in the layout
// (texture)", so **no tree and no blade of grass rendered at all** — while terrain, sky and
// the fire view were unaffected, which made the scene look merely bare rather than broken.
//
// A shader may declare a subset of a bind group layout, so bindings 3 and 5 are deliberately
// left undeclared here: this package samples neither the crack field nor the material table.
// The indices of what it DOES declare must match exactly.

@group(2) @binding(0) var albedoArray: texture_2d_array<f32>;
@group(2) @binding(1) var normalArray: texture_2d_array<f32>;
@group(2) @binding(2) var ormArray: texture_2d_array<f32>;
@group(2) @binding(4) var materialSampler: sampler;
