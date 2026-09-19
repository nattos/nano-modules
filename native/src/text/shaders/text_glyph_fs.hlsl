// glyph_fs stage of the text compositor — see text_composite.hlsli.
#include "text_composite.hlsli"

float4 main(GlyphOut inp) : SV_Target { return glyph_fs_impl(inp); }
