---
title: "Fast texture copy from viewports"
description: "Decreasing texture copy times by 99%"
date: "2024-09-05"
---

## A tale as old as time - CPU bottlenecking

As described in my earlier post ["My plan to render 1 million trees"](../00-rendering-lots-of-trees), my game has a grid system of sprites; each one displays a small chunk of the world as rendered by the SubViewport. But because the viewport moves around, we can't simply just set each sprite to have a `ViewportTexture` as this would mean they all would display the same thing.

I recently implemented an LOD system so that as you zoom in and out the game renders in more or less detail. I noticed as you zoomed in, the FPS really dropped as I increased the amount of detail to a level which I wanted.

What is interesting is this wasn't because of the number of trees being rendered, or really anything to do with the objects in the scene, but it was actually from two lines of code:

```gdscript
var image := $Subviewport.get_texture().get_image()
var texture := ImageTexture.create_from_image(image)
```

These lines would grab what the viewport is currently seeing, and the create an image texture to set on the sprite.

Under the hood `get_texture().get_image()` appears to mainly be calling `RenderingDevice::texture_get_data`. Depending on the texture, this will call on the graphics driver (in my case, Vulkan) to give it a readable pointer to the textures data, where it will then read the data into memory and return an array of bytes which get put into an image resource.

Clearly, this is CPU bottlenecked, because it has to read from GPU to CPU to get the image, and then straight back to the GPU via an ImageTexture. You can see the processing times scale pretty badly:

| Viewport size (square) | Processing time |
| --- | --- |
| 64 | 0.4ms |
| 1024 | 33 ms |
| 2048 | 89 ms |
(Note, I this is not a scientific test, I only ran it a few times)

For reference, 60fps is 1 frame every 16ms, so anything greater than this is less than ideal.

## The fix
After digging around a bit in the rendering code of Godot, I found this solution, which seems to remove the CPU from the operation entirely:

```gdscript
var rd := RenderingServer.get_rendering_device()
var imagesize := Vector2i(1024,1024)

# Get the texture RID and the texture format.
var in_texture = RenderingServer.texture_get_rd_texture($Subviewport.get_texture().get_rid(), false)
var in_tex_format = rd.texture_get_format(in_tex)

# Make a format to store the output based on the input texture.
# We need TEXTURE_USAGE_CAN_COPY_TO_BIT added so we can copy from the viewport to this one
var out_tex_format = in_tex_format
out_tex_format.usage_bits = out_tex_format.usage_bits | RenderingDevice.TEXTURE_USAGE_CAN_COPY_TO_BIT

# Create the output texture.
var out_texture = rd.texture_create(out_tex_format, RDTextureView.new(), [])

# Copy from the viewport texture to the output texture.
rd.texture_copy(in_texture, out_texture, Vector3.ZERO, Vector3.ZERO, Vector3(image_size.x, image_size.y, 0), 0, 0, 0, 0)

# Create a texture that can be applied to a sprite.
var sprite_tex = Texture2DRD.new()
sprite_tex.texture_rd_rid = out_texture

# Use the texture....

# After the resource is cleared, you may need to manually free the texture.
# It won't be cleared manually, because we created it directly ourselves.
# Wait at least 1 frame after it is not used.
await get_tree().process_frame
rd.free_rid(out_texture)
```

### How this works

### A note about terminology
There's a lot of obscure terminology, especially for someone who doesn't have much experience in 3D rendering pipelines and drivers (like myself circa 1 hour ago). I'll try to explain it simply, also, i'll probably make a few mistakes as well.

First lets make something clear about textures. There are two main things textures might refer to:

The first group I'll call 'Resource' textures - these are things like `Texture2D`, `ImageTexture`, `NoiseTexture2D`, etc... You would interact with these often and put them onto things like Materials, or save them to disk. These are high level.

The second group I'll call 'RenderingDevice' textures - these are lower level, essentially what 'Resource' textures link to under the hood. These are closer to the graphics driver.

Also if you weren't aware, a lot of things in Godot internally are reference by a `RID` or Resource ID. Think of this like a pointer.

#### Breaking it down

```gdscript
RenderingServer.texture_get_rd_texture($Subviewport.get_texture().get_rid(), false)
```

Remember the types of textures? They come into play here:
1. `Subviewport.get_texture()` - This returns a `ViewportTexture`, a subclass of `Texture2D`. This is the 'resource' texture I mentioned about before.
2. We get the viewport texture's RID, basically the internal resource ID of the texture.
3. `RenderingServer.texture_get_rd_texture` Looks up this 'resource' texture ID, and gives us the RID of a 'Rendering device' (RD) texture. This is the low level RID of the texture thats actually on the GPU.


```gdscript
var in_tex_format = rd.texture_get_format(in_tex)
var out_tex_format = in_tex_format
out_tex_format.usage_bits = out_tex_format.usage_bits | RenderingDevice.TEXTURE_USAGE_CAN_COPY_TO_BIT
var out_texture = rd.texture_create(out_tex_format, RDTextureView.new(), [])
```
The format tells the GPU how the data is structured (i.e. how many bytes to expect and where) and how it can be used.
We need to add `TEXTURE_USAGE_CAN_COPY_TO_BIT` to the output texture, since we will be copying the data to it. These are [bitwise operations](https://en.wikipedia.org/wiki/Bitwise_operation), hence the `|`.

Then we just make a new texture directly on the GPU (we bypass Godots 'resource' texture layer here) via the Rendering device.

```gdscript
rd.texture_copy(in_texture, out_texture, Vector3.ZERO, Vector3.ZERO, Vector3(image_size.x, image_size.y, 0), 0, 0, 0, 0)
```

Now for the good stuff! This is a neat little function that instructs the GPU to copy from the input texture (the viewports texture) to our new output texture. This means the actual texture data doesn't ever really touch the CPU.

Note the `Vector3` might seem a bit odd, but they are there for use with 3D textures (we don't care about the 3rd value, so its just zero here)

```gdscript
var sprite_tex = Texture2DRD.new()
sprite_tex.texture_rd_rid = out_texture
```
Now we have the texture copied, but it's only stored at the low level. We need a way to use this with everyday Godot things like Sprites. Luckily, in 4.2 `Texture2DRD` was added. This allows us to map a texture created on the RenderingDevice and link it with a normal texture that we can use in Materials and the like.

```gdscript
await get_tree().process_frame
rd.free_rid(out_texture)
```
After using the texture and we are done with it, we need to clean it up manually otherwise Godot will keep the texture in the GPU and the memory will slowly fill until your GPU dies. Waiting a frame stops currently in use objects (who might be visible currently but will disappear in the next frame) not 'flicker' because they lost their texture, since `free_rid` happens immediately.

### The results

| Viewport size (square) | Processing time via get_image | Processing time via texture_copy |
| --- | --- | --- |
| 64 | 0.4ms | 0.006ms |
| 1024 | 33 ms | 0.008ms |
| 2048 | 89 ms | 0.011ms |

The results are quite impressive. Clearly because the GPU is able to parallelise the copy, it scales a lot slower than the CPU bound version (which would theoretically scale linearly by the number of pixels).