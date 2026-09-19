// bg_vs stage of the text compositor — see text_composite.hlsli.
#include "text_composite.hlsli"

BgOut main(uint vid : SV_VertexID) { return bg_vs_impl(vid); }
