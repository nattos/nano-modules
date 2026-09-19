// bg_fs stage of the text compositor — see text_composite.hlsli.
#include "text_composite.hlsli"

float4 main(BgOut inp) : SV_Target { return bg_fs_impl(inp); }
