// BC1 (DXT1) decode compute shader.
//
// Reads packed BC1 blocks from a storage buffer and writes decoded RGBA8 to a
// storage texture. One thread per output pixel; workgroup 8x8 lines up with the
// rest of the codebase. See dxv_decoder/main.cpp for the binding wiring.

StructuredBuffer<uint>  blocks    : register(t0);
RWTexture2D<float4>     outputTex : register(u1);

static float unpack5(uint v) {
    // 5-bit channel → 8-bit via bit replication, then normalize.
    return (float)((v << 3) | (v >> 2)) * (1.0 / 255.0);
}
static float unpack6(uint v) {
    return (float)((v << 2) | (v >> 4)) * (1.0 / 255.0);
}
static float4 unpackRGB565(uint c) {
    return float4(unpack5((c >> 11) & 0x1f),
                  unpack6((c >> 5)  & 0x3f),
                  unpack5((c >> 0)  & 0x1f),
                  1.0);
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
    uint w, h;
    outputTex.GetDimensions(w, h);
    if (gid.x >= w || gid.y >= h) return;

    uint blocks_x = (w + 3) / 4;
    uint bx = gid.x / 4u;
    uint by = gid.y / 4u;
    uint px = gid.x & 3u;
    uint py = gid.y & 3u;

    uint block_idx = by * blocks_x + bx;
    // Each BC1 block is 8 bytes = 2 uint elements in the storage buffer.
    uint c01    = blocks[block_idx * 2 + 0]; // color0 (low16) + color1 (high16)
    uint lookup = blocks[block_idx * 2 + 1];

    uint c0 = c01 & 0xffffu;
    uint c1 = (c01 >> 16) & 0xffffu;

    float4 color0 = unpackRGB565(c0);
    float4 color1 = unpackRGB565(c1);

    // Bit i*2 ... i*2+1 of `lookup` is the code for pixel (i%4, i/4).
    uint code = (lookup >> ((py * 4u + px) * 2u)) & 0x3u;

    float4 outColor;
    if (c0 > c1) {
        // 4-color block (opaque)
        if      (code == 0u) outColor = color0;
        else if (code == 1u) outColor = color1;
        else if (code == 2u) outColor = lerp(color0, color1, 1.0 / 3.0);
        else                 outColor = lerp(color0, color1, 2.0 / 3.0);
    } else {
        // 3-color + transparent-black block
        if      (code == 0u) outColor = color0;
        else if (code == 1u) outColor = color1;
        else if (code == 2u) outColor = (color0 + color1) * 0.5;
        else                 outColor = float4(0, 0, 0, 0);
    }

    outputTex[gid.xy] = outColor;
}
