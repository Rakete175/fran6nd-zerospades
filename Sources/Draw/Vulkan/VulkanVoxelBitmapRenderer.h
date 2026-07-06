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

#pragma once

#include <cstdint>
#include <vector>
#include <vulkan/vulkan.h>
#include <Core/RefCountedObject.h>

namespace spades {
	namespace client {
		class GameMap;
	}
	namespace gui {
		class SDLVulkanDevice;
	}
	namespace draw {
		class VulkanRenderer;
		class VulkanImage;
		class VulkanBuffer;

		// GPU-resident voxel acceleration structure for software ray tracing
		// ("RTX" path, step 1).
		//
		// The whole game map (512x512x64) is packed into a single
		// 512x512 RG32_UINT texture: one texel per (x, y) column, 64 bits
		// per texel (R = z 0..31, G = z 32..63), bit set = solid voxel.
		// That is 2 MB of VRAM total and lets a fragment shader ray-march
		// the entire map with a 2D DDA — one texel fetch tests a whole
		// 64-voxel column, so rays typically resolve within a handful of
		// fetches. Runs on any Vulkan 1.0 GPU; no ray-tracing extensions,
		// no compute requirement, maximum hardware compatibility.
		//
		// Incremental updates mirror VulkanMapShadowRenderer: block edits
		// mark their column dirty via GameMapChanged(); Update() regenerates
		// dirty columns on the CPU (64 IsSolid tests each) and re-uploads
		// the bitmap when anything changed.
		class VulkanVoxelBitmapRenderer {
			VulkanRenderer& renderer;
			Handle<gui::SDLVulkanDevice> device;
			client::GameMap* map;

			Handle<VulkanImage> bitmapImage;
			Handle<VulkanBuffer> stagingBuffer;

			int w, h, d;

			// One dirty bit per column, packed 32 per uint32.
			size_t updateBitmapPitch;
			std::vector<uint32_t> updateBitmap;

			// CPU copy of the column bitmask. Two uint32 per column (lo, hi).
			std::vector<uint32_t> bitmap;

			void GenerateColumn(int x, int y, uint32_t& lo, uint32_t& hi);
			void MarkUpdate(int x, int y);

		public:
			VulkanVoxelBitmapRenderer(VulkanRenderer& renderer, client::GameMap* map);
			~VulkanVoxelBitmapRenderer();

			void GameMapChanged(int x, int y, int z, client::GameMap*);
			void Update(VkCommandBuffer commandBuffer);

			VulkanImage* GetBitmapImage() { return bitmapImage.GetPointerOrNull(); }
		};
	} // namespace draw
} // namespace spades
