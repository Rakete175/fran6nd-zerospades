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

#include "VulkanVoxelBitmapRenderer.h"
#include "VulkanRenderer.h"
#include "VulkanImage.h"
#include "VulkanBuffer.h"
#include <Client/GameMap.h>
#include <Gui/SDLVulkanDevice.h>
#include <Core/Debug.h>
#include <Core/Settings.h>

// Master switch for the software ray-tracing ("RTX") path of the Vulkan
// renderer. Step 1: per-pixel ray-traced sun shadows on map geometry
// (r_physicalLighting path). Requires no GPU ray-tracing extensions.
DEFINE_SPADES_SETTING(r_vulkanRaytracedShadows, "0");

namespace spades {
	namespace draw {

		VulkanVoxelBitmapRenderer::VulkanVoxelBitmapRenderer(VulkanRenderer& renderer,
		                                                     client::GameMap* map)
		    : renderer(renderer), device(renderer.GetDevice()), map(map) {
			SPADES_MARK_FUNCTION();

			w = map->Width();
			h = map->Height();
			d = map->Depth();
			SPAssert(d <= 64);

			updateBitmapPitch = (w + 31) / 32;
			updateBitmap.resize(updateBitmapPitch * h, 0u);
			bitmap.resize((size_t)w * h * 2);

			// Build the full column bitmask on the CPU.
			for (int y = 0; y < h; y++) {
				for (int x = 0; x < w; x++) {
					uint32_t lo, hi;
					GenerateColumn(x, y, lo, hi);
					bitmap[((size_t)x + (size_t)y * w) * 2 + 0] = lo;
					bitmap[((size_t)x + (size_t)y * w) * 2 + 1] = hi;
				}
			}

			// 512x512 RG32_UINT — 8 bytes per texel, 2 MB. R = z bits 0..31,
			// G = z bits 32..63. Sampled with texelFetch; NEAREST sampler is
			// mandatory for an integer format anyway.
			bitmapImage = Handle<VulkanImage>::New(
				device, (uint32_t)w, (uint32_t)h,
				VK_FORMAT_R32G32_UINT,
				VK_IMAGE_TILING_OPTIMAL,
				VK_IMAGE_USAGE_TRANSFER_DST_BIT | VK_IMAGE_USAGE_SAMPLED_BIT,
				VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
			bitmapImage->CreateSampler(VK_FILTER_NEAREST, VK_FILTER_NEAREST,
			                           VK_SAMPLER_ADDRESS_MODE_REPEAT, false);

			size_t bufferSize = (size_t)w * h * 8;
			stagingBuffer = Handle<VulkanBuffer>::New(
				device, bufferSize,
				VK_BUFFER_USAGE_TRANSFER_SRC_BIT,
				VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);

			stagingBuffer->UpdateData(bitmap.data(), bufferSize);

			// Initial upload via one-time command buffer (same pattern as
			// VulkanMapShadowRenderer).
			VkCommandBufferAllocateInfo allocInfo{};
			allocInfo.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO;
			allocInfo.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
			allocInfo.commandPool = device->GetCommandPool();
			allocInfo.commandBufferCount = 1;

			VkCommandBuffer commandBuffer;
			if (vkAllocateCommandBuffers(device->GetDevice(), &allocInfo, &commandBuffer) != VK_SUCCESS) {
				SPRaise("Failed to allocate command buffer for voxel bitmap upload");
			}

			VkCommandBufferBeginInfo beginInfo{};
			beginInfo.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
			beginInfo.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
			vkBeginCommandBuffer(commandBuffer, &beginInfo);

			bitmapImage->TransitionLayout(commandBuffer, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
				0, VK_ACCESS_TRANSFER_WRITE_BIT,
				VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT);

			bitmapImage->CopyFromBuffer(commandBuffer, stagingBuffer->GetBuffer());

			bitmapImage->TransitionLayout(commandBuffer, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL,
				VK_ACCESS_TRANSFER_WRITE_BIT, VK_ACCESS_SHADER_READ_BIT,
				VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT);

			vkEndCommandBuffer(commandBuffer);

			VkSubmitInfo submitInfo{};
			submitInfo.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO;
			submitInfo.commandBufferCount = 1;
			submitInfo.pCommandBuffers = &commandBuffer;

			vkQueueSubmit(device->GetGraphicsQueue(), 1, &submitInfo, VK_NULL_HANDLE);
			vkQueueWaitIdle(device->GetGraphicsQueue());

			vkFreeCommandBuffers(device->GetDevice(), device->GetCommandPool(), 1, &commandBuffer);

			SPLog("Voxel bitmap renderer created (%dx%dx%d, %zu KB)", w, h, d, bufferSize / 1024);
		}

		VulkanVoxelBitmapRenderer::~VulkanVoxelBitmapRenderer() { SPADES_MARK_FUNCTION(); }

		void VulkanVoxelBitmapRenderer::GenerateColumn(int x, int y, uint32_t& lo, uint32_t& hi) {
			lo = 0u;
			hi = 0u;
			for (int z = 0; z < d && z < 32; z++)
				if (map->IsSolid(x, y, z))
					lo |= 1u << z;
			for (int z = 32; z < d; z++)
				if (map->IsSolid(x, y, z))
					hi |= 1u << (z - 32);
		}

		void VulkanVoxelBitmapRenderer::MarkUpdate(int x, int y) {
			x &= w - 1;
			y &= h - 1;
			updateBitmap[(x >> 5) + y * updateBitmapPitch] |= 1UL << (x & 31);
		}

		void VulkanVoxelBitmapRenderer::GameMapChanged(int x, int y, int z, client::GameMap*) {
			MarkUpdate(x, y);
		}

		void VulkanVoxelBitmapRenderer::Update(VkCommandBuffer commandBuffer) {
			SPADES_MARK_FUNCTION();

			// Nothing consumes the bitmap when the feature is off; skip the
			// regeneration work entirely (dirty bits keep accumulating and are
			// applied the moment the feature is switched on).
			if (!((int)r_vulkanRaytracedShadows))
				return;

			bool anyChanges = false;

			for (size_t i = 0; i < updateBitmap.size(); i++) {
				if (updateBitmap[i] == 0)
					continue;

				int y = static_cast<int>(i / updateBitmapPitch);
				int x = static_cast<int>((i - y * updateBitmapPitch) * 32);

				for (int j = 0; j < 32; j++) {
					if (!(updateBitmap[i] & (1UL << j)))
						continue;
					uint32_t lo, hi;
					GenerateColumn(x + j, y, lo, hi);
					size_t base = ((size_t)(x + j) + (size_t)y * w) * 2;
					if (bitmap[base] != lo || bitmap[base + 1] != hi) {
						bitmap[base] = lo;
						bitmap[base + 1] = hi;
						anyChanges = true;
					}
				}

				updateBitmap[i] = 0;
			}

			if (!anyChanges)
				return;

			stagingBuffer->UpdateData(bitmap.data(), (size_t)w * h * 8);

			bitmapImage->TransitionLayout(commandBuffer, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
				VK_ACCESS_SHADER_READ_BIT, VK_ACCESS_TRANSFER_WRITE_BIT,
				VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT);

			bitmapImage->CopyFromBuffer(commandBuffer, stagingBuffer->GetBuffer());

			bitmapImage->TransitionLayout(commandBuffer, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL,
				VK_ACCESS_TRANSFER_WRITE_BIT, VK_ACCESS_SHADER_READ_BIT,
				VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT);
		}

	} // namespace draw
} // namespace spades
