/*
 Copyright (c) 2013 Fran6nd

 This file is part of ZeroSpades, a fork of OpenSpades.

 OpenSpades is free software: you can redistribute it and/or modify
 it under the terms of the GNU General Public License as published by
 the Free Software Foundation, either version 3 of the License, or
 (at your option) any later version.

 OpenSpades is distributed in the hope that it will be useful,
 but WITHOUT ANY WARRANTY; without even the implied warranty of
 MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 GNU General Public License for more details.

 You should have received a copy of the GNU General Public License
 along with OpenSpades.  If not, see <http://www.gnu.org/licenses/>.

 */

#version 450

layout(set = 0, binding = 0) uniform sampler2D mapShadowTexture;
layout(set = 0, binding = 1) uniform sampler3D ambientShadowTexture;
layout(set = 0, binding = 2) uniform sampler3D radiosityTextureFlat;
layout(set = 0, binding = 3) uniform sampler3D radiosityTextureX;
layout(set = 0, binding = 4) uniform sampler3D radiosityTextureY;
layout(set = 0, binding = 5) uniform sampler3D radiosityTextureZ;
// Binding 6 (AO atlas) is only used by the non-phys shader; not declared here.
// Software ray tracing acceleration structure: one texel per (x, y) map
// column, 64 bits per texel (r = z 0..31, g = z 32..63), bit set = solid.
layout(set = 0, binding = 7) uniform usampler2D voxelColumnTexture;

layout(push_constant) uniform PushConstants {
	mat4 projectionViewMatrix;
	vec3 modelOrigin;
	float fogDistance;
	vec3 viewOrigin;
	float raytracedShadows; // > 0.5: use ray-traced sun shadows
	vec3 fogColor;
	float _pad2;
	vec3 sunDirection; // points toward the sun (renderer GetSunDirection)
	float _pad3;
	mat4 viewMatrix;
} pushConstants;

layout(location = 0) in vec4 color;           // xyz = vertexColor, w = sun lambert
layout(location = 1) in vec3 ambientLight;     // hemisphere ambient fallback
layout(location = 2) in vec3 fogDensity;
layout(location = 3) in vec3 inFogColor;
layout(location = 4) in vec3 shadowCoord;
layout(location = 5) in vec3 viewSpaceCoord;
layout(location = 6) in vec3 viewSpaceNormal;
layout(location = 7) in vec3 reflectionDir;
layout(location = 8) in vec3 aoCoord;          // 3D coords into AO texture
layout(location = 9) in vec3 radiosityTextureCoord;
layout(location = 10) in vec3 normalVarying;
layout(location = 11) in vec3 worldPosVarying;

layout(location = 0) out vec4 fragColor;

vec3 DecodeRadiosityValue(vec3 val) {
	val *= 1023.0 / 1022.0;
	val = (val * 2.0) - 1.0;
	return val;
}

// Oren-Nayar diffuse BRDF
float OrenNayar(float sigma, float dotLight, float dotEye) {
	float sigma2 = sigma * sigma;
	float A = 1.0 - 0.5 * sigma2 / (sigma2 + 0.33);
	float B = 0.45 * sigma2 / (sigma2 + 0.09);
	float scale = 1.0 / A;
	float scaledB = B * scale;

	vec2 dotLightEye = clamp(vec2(dotLight, dotEye), 0.0, 1.0);
	vec2 sinLightEye = sqrt(1.0 - dotLightEye * dotLightEye);
	float alphaSin = max(sinLightEye.x, sinLightEye.y);
	float betaCos = max(dotLightEye.x, dotLightEye.y);
	float betaCos2 = betaCos * betaCos;
	float betaTan = 1.0 / sqrt(betaCos2 / max(1.0 - betaCos2, 0.001));

	vec4 vecs = vec4(dotLightEye, sinLightEye);
	float diffCos = dot(vecs.xz, vecs.yw);

	return dotLight * (1.0 + scaledB * diffCos * alphaSin * betaTan);
}

// GGX microfacet distribution
float GGXDistribution(float m, float dotHalf) {
	float m2 = m * m;
	float t = dotHalf * dotHalf * (m2 - 1.0) + 1.0;
	return m2 / (3.141592653 * t * t);
}

// Cook-Torrance specular BRDF
float CookTorrance(vec3 eyeVec, vec3 lightVec, vec3 normal) {
	vec3 halfVec = lightVec + eyeVec;
	halfVec = (dot(halfVec, halfVec) < 0.00000000001)
		? vec3(1.0, 0.0, 0.0) : normalize(halfVec);

	float dotNL = max(dot(normal, lightVec), 0.001);
	float dotNV = max(dot(normal, eyeVec), 0.001);
	float dotNH = max(dot(normal, halfVec), 0.001);
	float dotVH = max(dot(eyeVec, halfVec), 0.001);

	float m = 0.3;
	float distribution = GGXDistribution(m, dotNH);

	float fresnel2 = 1.0 - dotVH;
	float fresnel = 0.03 + 0.1 * fresnel2 * fresnel2;

	float a = m * 0.7978, ia = 1.0 - a;
	float visibility = (dotNL * ia + a) * (dotNV * ia + a);
	visibility = 0.25 / visibility;

	return distribution * fresnel * visibility;
}

// ---------------------------------------------------------------------------
// Software ray tracing ("RTX" path, step 1: sun shadows)
//
// The map is a 512x512x64 voxel grid; voxelColumnTexture stores a 64-bit
// solidity bitmask per (x, y) column. A shadow ray is marched with a 2D DDA
// over columns; every column crossing tests the full 64-voxel span with one
// texel fetch and a couple of bit masks. Typical rays resolve in < 10
// fetches. Works on any Vulkan 1.0 GPU — no RT extensions required.
// ---------------------------------------------------------------------------

// Inclusive bitmask for bits [a, b] of a 32-bit lane (b < a gives 0).
uint LaneRangeMask(int a, int b) {
	if (b < a || b < 0 || a > 31)
		return 0u;
	a = clamp(a, 0, 31);
	b = clamp(b, 0, 31);
	uint hiMask = (b >= 31) ? 0xFFFFFFFFu : ((1u << uint(b + 1)) - 1u);
	uint loMask = (a <= 0) ? 0u : ((1u << uint(a)) - 1u);
	return hiMask & ~loMask;
}

// Inclusive bitmask for voxel z range [z0, z1] split across (lo, hi) lanes.
uvec2 ColumnRangeMask(int z0, int z1) {
	return uvec2(LaneRangeMask(z0, z1), LaneRangeMask(z0 - 32, z1 - 32));
}

// Trace a ray from `origin` toward the sun. Returns 1.0 (lit) or 0.0 (shadow).
float TraceSunShadow(vec3 origin, vec3 dir) {
	// z decreases toward the sky. Rays that never go up cannot escape;
	// keep them on the cheap heightmap result instead (caller decides).
	const float kMaxDistance = 160.0;

	// Distance at which the ray leaves the map through the top (z < 0).
	float tMax = kMaxDistance;
	if (dir.z < -0.0001)
		tMax = min(tMax, (origin.z + 0.5) / -dir.z);

	vec2 d = dir.xy;
	// Avoid division by zero for axis-aligned rays.
	vec2 safeD = vec2(abs(d.x) < 1e-6 ? 1e-6 : d.x,
	                  abs(d.y) < 1e-6 ? 1e-6 : d.y);
	vec2 invD = 1.0 / safeD;

	ivec2 cell = ivec2(floor(origin.xy));
	ivec2 stepDir = ivec2(sign(safeD));
	vec2 deltaDist = abs(invD);

	// Parametric distance to the first x / y column boundary.
	vec2 frac = origin.xy - vec2(cell);
	vec2 sideDist;
	sideDist.x = (stepDir.x > 0 ? (1.0 - frac.x) : frac.x) * deltaDist.x;
	sideDist.y = (stepDir.y > 0 ? (1.0 - frac.y) : frac.y) * deltaDist.y;

	float t = 0.0;
	for (int i = 0; i < 96; i++) {
		float tNext = min(min(sideDist.x, sideDist.y), tMax);

		// Voxel z span crossed inside the current column segment [t, tNext].
		float zA = origin.z + dir.z * t;
		float zB = origin.z + dir.z * tNext;
		float zLo = min(zA, zB);
		float zHi = max(zA, zB);

		if (zHi < 0.0)
			return 1.0; // fully above the map: reached the sky
		if (zLo >= 63.0)
			return 0.0; // heading into the solid map floor

		int z0 = int(floor(max(zLo, 0.0)));
		int z1 = int(floor(min(zHi, 62.999)));

		uvec2 bits = texelFetch(voxelColumnTexture, cell & ivec2(511), 0).rg;
		uvec2 mask = ColumnRangeMask(z0, z1);
		if (((bits.x & mask.x) | (bits.y & mask.y)) != 0u)
			return 0.0; // solid voxel intersected: in shadow

		if (tNext >= tMax)
			return 1.0;

		// Advance the 2D DDA to the next column.
		t = tNext;
		if (sideDist.x < sideDist.y) {
			sideDist.x += deltaDist.x;
			cell.x += stepDir.x;
		} else {
			sideDist.y += deltaDist.y;
			cell.y += stepDir.y;
		}
	}
	return 1.0;
}

void main() {
	// Evaluate map shadow
	float shadow;
	if (pushConstants.raytracedShadows > 0.5) {
		// Per-pixel ray-traced sun shadow. Offset along the surface normal
		// and the ray direction to avoid self-intersection with the voxel
		// the fragment sits on.
		vec3 nrmWS = normalize(normalVarying);
		vec3 sunDirWS = normalize(pushConstants.sunDirection);
		vec3 rayOrigin = worldPosVarying + nrmWS * 0.02 + sunDirWS * 0.01;
		shadow = TraceSunShadow(rayOrigin, sunDirWS);
	} else {
		float shadowVal = texture(mapShadowTexture, shadowCoord.xy).w;
		shadow = (shadowVal < shadowCoord.z - 0.0001) ? 0.0 : 1.0;
	}

	// Per-block ambient occlusion (matching GL MapRadiosity.fs).
	vec2 ambTexVal = texture(ambientShadowTexture, aoCoord).xy;
	float aoFactor = max(ambTexVal.x / max(ambTexVal.y, 0.25), 0.0);

	// Directional radiosity (port of GL MapRadiosity.fs EvaluateRadiosity)
	vec3 radiosity = DecodeRadiosityValue(texture(radiosityTextureFlat, radiosityTextureCoord).xyz);
	vec3 nrm = normalize(normalVarying);
	radiosity += nrm.x * DecodeRadiosityValue(texture(radiosityTextureX, radiosityTextureCoord).xyz);
	radiosity += nrm.y * DecodeRadiosityValue(texture(radiosityTextureY, radiosityTextureCoord).xyz);
	radiosity += nrm.z * DecodeRadiosityValue(texture(radiosityTextureZ, radiosityTextureCoord).xyz);
	radiosity = max(radiosity, 0.0) * 1.5;

	float aoTerm = aoFactor * (0.8 - nrm.z * 0.2);
	// Ambient color matching GL GLShadowShader: fog * 0.5 with a minimum
	// luminance floor of 0.35 (keeps things visible when the sky is near-black).
	vec3 ambientColor = inFogColor * 0.5;
	float ambL = (ambientColor.x + ambientColor.y + ambientColor.z) / 3.0;
	ambientColor += ((ambientColor + 0.003) / (ambL + 0.003)) * max(0.35 - ambL, 0.0);

	fragColor = vec4(color.xyz, 1.0);
	vec3 diffuseShading = radiosity + aoTerm * ambientColor;
	float shadowing = shadow * 0.6;

	vec3 eyeVec = -normalize(viewSpaceCoord);

	// Compute view-space light direction (sun from the renderer, GetSunDirection)
	vec3 sunDir = normalize(pushConstants.sunDirection);
	vec3 viewSpaceLight = normalize((pushConstants.viewMatrix * vec4(sunDir, 0.0)).xyz);

	float dotNL = max(color.w, 0.001);
	float dotNV = max(dot(viewSpaceNormal, eyeVec), 0.001);

	// Fresnel term
	float fresnel2 = 1.0 - dotNV;
	float fresnel = 0.03 + 0.1 * fresnel2 * fresnel2;

	// Approximate specular ambient from reflection direction
	vec3 reflectWS = normalize(reflectionDir);
	float reflHemisphere = 1.0 - reflectWS.z * 0.2;
	vec3 specularShading = mix(inFogColor, vec3(1.0), 0.5) * 0.5 * reflHemisphere;

	// Sun diffuse/specular
	if (shadowing > 0.0 && dotNL > 0.0) {
		float sunDiffuseShading = OrenNayar(0.8, dotNL, dotNV);
		diffuseShading += sunDiffuseShading * shadowing;

		float sunSpecularShading = CookTorrance(eyeVec, viewSpaceLight, viewSpaceNormal);
		fragColor.xyz += sunSpecularShading * shadowing;
	}

	// Blend diffuse and specular with Fresnel
	fragColor.xyz = mix(diffuseShading * fragColor.xyz, specularShading, fresnel);

	// Apply fog
	fragColor.xyz = mix(fragColor.xyz, inFogColor, fogDensity);
	fragColor.xyz = max(fragColor.xyz, 0.0);
}
