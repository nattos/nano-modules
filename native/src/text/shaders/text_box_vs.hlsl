// box_vs stage of the text compositor — see text_composite.hlsli.
#include "text_composite.hlsli"

BoxOut main(uint vid : SV_VertexID, uint iid : SV_InstanceID) { return box_vs_impl(vid, iid); }
