// box_fs stage of the text compositor — see text_composite.hlsli.
#include "text_composite.hlsli"

float4 main(BoxOut inp) : SV_Target { return box_fs_impl(inp); }
